"""Intent: fork exact pre-relation state atomically without modifying origin.

Real PostgreSQL connection-private TEMP tables preserve actual columns/indexes.
Both engines connect only to the explicit local test DB; URL routing is doubled
to those connections. Nodes have an explicit immediate self-FK to exercise
forward references. Other production FKs and physical DB provisioning are not
covered. Connections are disposed afterwards, destroying TEMP tables only.
"""
import copy
import os
import uuid
from urllib.parse import urlparse
import pytest
from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance, Node, Relationship, PipelineArtifact
from lct_python_backend.services.transcript.passage_journal import build_record, _source, _hash
from lct_python_backend.services.transcript.reconciliation_checkpoint import capture_reconciliation
from tools.public_replay_harness import ensure_replay
from tools.replay_public_source_inspection import FIELDS
from tools.public_replay_fork import fork_replay, MODELS


@pytest.mark.asyncio
@pytest.mark.parametrize('external_llm_ok', [False, True])
async def test_fork_preserves_original_and_only_changes_relation_policy(monkeypatch, external_llm_ok):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated loopback database required')
    parsed = urlparse(url)
    assert parsed.hostname == '127.0.0.1' and parsed.port == 55439
    engines = [create_async_engine(url, pool_size=1, max_overflow=0) for _ in range(2)]
    cleanup = [engine.dispose for engine in engines]
    sessions = [async_sessionmaker(engine, expire_on_commit=False) for engine in engines]
    names = ['lct_public_replay_synthetic_origin', 'lct_public_replay_synthetic_target']
    urls = ['postgresql+asyncpg://aditya@127.0.0.1:55439/' + name for name in names]
    run, owner = 'synthetic-fork-' + uuid.uuid4().hex, 'synthetic-owner'
    old = {'runtime': 'r'*64, 'reconciliation': 'a'*64, 'aggregation': 'g'*64, 'question_review': 'q'*64}
    new = {**old, 'reconciliation': 'b'*64}
    uid, first, second, chunk, edge_id = [uuid.uuid4() for _ in range(5)]
    source = [{field: None for field in FIELDS}]
    source[0].update(id=str(uid), text='Synthetic unchanged source.', sequence_number=1,
                     speaker_id='S', speaker_source='manual', speaker_revision=0)
    try:
        for engine in engines:
            async with engine.begin() as conn:
                for table in ('conversations', 'utterances', 'nodes', 'relationships', 'pipeline_artifacts', 'clusters'):
                    await conn.execute(text(f'CREATE TEMP TABLE {table} '
                        f'(LIKE public.{table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)'))
                await conn.execute(text('ALTER TABLE nodes ADD CONSTRAINT synthetic_predecessor '
                                        'FOREIGN KEY(predecessor_id) REFERENCES nodes(id)'))
        async with sessions[0].begin() as db:
            cid = await ensure_replay(db, run_id=run, owner_id=owner, source=source, policy=old,
                                      external_llm_ok=external_llm_ok)
            rows = [dict(id=nid, conversation_id=cid, node_name='Synthetic leaf', summary='Original meaning',
                         chunk_ids=[chunk], utterance_ids=[uid], level=1, predecessor_id=other)
                    for nid, other in [(first, second), (second, first)]]
            await db.execute(insert(Node.__table__).values(rows))
            raw = _source(await db.get(Utterance, uid))
            record = build_record(1, 0, [raw], {'nodes': [
                {'id': str(nid), 'chunk_id': str(chunk), 'utterance_ids': [str(uid)]} for nid in (first, second)],
                'chunks': {str(chunk): raw['text']}, 'utterance_chunk_map': {str(chunk): [str(uid)]}}, old['runtime'])
            db.add(PipelineArtifact(conversation_id=cid, stage='conversation_passage_v1', stage_index=1,
                artifact_type='passage_checkpoint', artifact_json=record, content_hash=record['digest']))
            db.add(Relationship(id=edge_id, conversation_id=cid, from_node_id=first, to_node_id=second,
                relationship_type='supports', relationship_subtype='reconciled:source_cited'))
            basis = await capture_reconciliation(db, conversation_id=str(cid), owner_id=owner)
            body = {'basis_hash': basis['basis_hash'], 'edges': [{'id': str(edge_id), 'from_node_id': str(first), 'to_node_id': str(second),
                              'relation_type': 'supports', 'disposition': 'created'}]}
            db.add(PipelineArtifact(conversation_id=cid, stage='conversation_relation_review_v1', stage_index=0,
                artifact_type='source_reviewed_relations', artifact_json=body, content_hash=_hash(body)))
        async def snapshot(session):
            async with session() as db:
                return {model.__tablename__: [dict(row) for row in (await db.execute(
                    select(model.__table__).order_by(model.__table__.c.id))).mappings()] for model in MODELS}
        original = await snapshot(sessions[0])
        monkeypatch.setattr('tools.public_replay_fork.create_async_engine',
                            lambda route, **kwargs: engines[urls.index(route)])
        # Keep connection-private tables available for independent postconditions.
        original_dispose = AsyncEngine.dispose
        async def retain_test_connections(engine, *args, **kwargs):
            if engine not in engines:
                await original_dispose(engine, *args, **kwargs)
        monkeypatch.setattr(AsyncEngine, 'dispose', retain_test_connections)
        args = dict(source_url=urls[0], target_url=urls[1], run_id=run, owner_id=owner,
                    source=source, policy=new, previous_reconciliation=old['reconciliation'],
                    external_llm_ok=external_llm_ok)
        # Privacy is immutable across a relation-policy fork, in either direction.
        # Rejection occurs at the origin check, before any target rows are written.
        with pytest.raises(ValueError, match='Resume source, owner, run or policy differs'):
            await fork_replay(**{**args, 'external_llm_ok': not external_llm_ok})
        assert await snapshot(sessions[0]) == original
        assert all(not rows for rows in (await snapshot(sessions[1])).values())
        for wrong in [{'owner_id': 'foreign'}, {'policy': {**new, 'runtime': 'changed'}},
                      {'source': [{**source[0], 'text': 'Altered source'}]}, {'target_url': urls[0]}]:
            with pytest.raises(ValueError):
                await fork_replay(**{**args, **wrong})
            assert await snapshot(sessions[0]) == original
            assert all(not rows for rows in (await snapshot(sessions[1])).values())
        original_node = next(row for row in original['nodes'] if row['id'] == first)
        async with sessions[0].begin() as db:
            await db.execute(update(Node).where(Node.id == first).values(
                summary='Changed after relation review', updated_at=original_node['updated_at']))
        with pytest.raises(ValueError, match='canonical leaves changed'):
            await fork_replay(**args)
        assert all(not rows for rows in (await snapshot(sessions[1])).values())
        async with sessions[0].begin() as db:
            await db.execute(update(Node).where(Node.id == first).values(
                summary=original_node['summary'], updated_at=original_node['updated_at']))
        assert await snapshot(sessions[0]) == original
        receipt = await fork_replay(**args)
        assert await snapshot(sessions[0]) == original
        target = await snapshot(sessions[1])
        assert target['nodes'] == original['nodes']
        assert target['utterances'] == original['utterances']
        assert target['relationships'] == []
        assert target['conversations'][0]['source_metadata']['replay_policy'] == new
        unchanged = copy.deepcopy(target['conversations'])
        unchanged[0]['source_metadata']['replay_policy'] = old
        assert unchanged == original['conversations']
        assert receipt['excluded_created_edge_ids'] == [str(edge_id)]
        assert {row['artifact_type'] for row in target['pipeline_artifacts']} == {'passage_checkpoint', 'public_replay_fork'}
        assert next(row for row in target['pipeline_artifacts'] if row['artifact_type'] == 'passage_checkpoint') == next(
            row for row in original['pipeline_artifacts'] if row['artifact_type'] == 'passage_checkpoint')
        with pytest.raises(ValueError, match='target must be empty'):
            await fork_replay(**args)
        assert await snapshot(sessions[1]) == target
    finally:
        for dispose in cleanup:
            await dispose()
