"""Test intent: real canonical edges and review receipts commit atomically,
retain later-to-earlier direction, survive retry without duplicates, preserve
human edits and ambiguous ownership, and reject stale source/owner/consent.
Only random synthetic rows in the opt-in isolated PostgreSQL database are used.
"""
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Node, Relationship, Utterance
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.transcript.inspection_relations import validate_relation_review
from lct_python_backend.services.transcript.passage_journal import JournalConflict
from lct_python_backend.services.transcript.reconciliation_checkpoint import capture_reconciliation, checkpoint_relation_review
from lct_python_backend.tests.unit.test_inspection_relations import fixture


@pytest.mark.asyncio
async def test_canonical_relation_atomicity_recovery_and_human_boundaries():
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, early, late, old_node, new_node = [uuid.uuid4() for _ in range(5)]
    owner = f'synthetic-reconciliation-{cid}'
    scope = {'conversation_id': str(cid), 'owner_id': owner}
    context, raw = fixture()
    replacements = {'u1': str(early), 'u90': str(late)}
    for observation in [context['focal'], *context['candidates']]:
        for excerpt in observation['source_excerpts']:
            excerpt['utterance_id'] = replacements[excerpt['utterance_id']]
            excerpt.update(sequence_number=1 if excerpt['utterance_id'] == str(early) else 90,
                           speaker_id='A', speaker_revision=0, end=len(excerpt['text']))
    for citation in raw['comparisons'][0]['relations'][0]['evidence']:
        citation['utterance_id'] = replacements[citation['utterance_id']]
    providers = [{'id': 'local', 'trust_scope': 'owner_private'}]
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic source reconciliation',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            for observation in [context['focal'], *context['candidates']]:
                excerpt = observation['source_excerpts'][0]
                db.add(Utterance(id=uuid.UUID(excerpt['utterance_id']), conversation_id=cid,
                    sequence_number=excerpt['sequence_number'], text=excerpt['text'], speaker_id='A'))
        async with sessions.begin() as db:
            await persist_graph(db=db, **scope, append_only=True, commit=False, existing_json=[
                {'id': str(old_node), 'semantic_level': 1, 'node_name': 'Question', 'summary': 'Borrowing remains open.',
                 'utterance_ids': [str(early)], 'thread_id': 'borrowing'},
                {'id': str(new_node), 'semantic_level': 1, 'node_name': 'Return', 'summary': 'No borrowing decision.',
                 'utterance_ids': [str(late)], 'thread_id': 'borrowing'}])
        async with sessions() as db:
            snapshot = await capture_reconciliation(db, **scope)
        context.update(input_hash=snapshot['source_snapshot']['input_hash'], available_through_sequence=90)
        review = {**validate_relation_review(raw, context), 'policy_fingerprint': 'synthetic-policy'}
        args = {**scope, 'snapshot': snapshot, 'context': context, 'batch_index': 0,
                'policy_fingerprint': 'synthetic-policy', 'providers': providers, 'review': review}
        with pytest.raises(PermissionError):
            async with sessions.begin() as db:
                await checkpoint_relation_review(db, **{**args, 'owner_id': 'wrong-owner'})
        with pytest.raises(RuntimeError, match='synthetic rollback'):
            async with sessions.begin() as db:
                await checkpoint_relation_review(db, **args)
                raise RuntimeError('synthetic rollback after flush')
        async with sessions() as db:
            assert not (await db.execute(select(Relationship).where(
                Relationship.conversation_id == cid, Relationship.relationship_type == 'return_to_thread'))).scalars().all()
        async with sessions.begin() as db:
            receipt = await checkpoint_relation_review(db, **args)
        identity = receipt['edges'][0]['id']
        assert receipt['edges'][0]['from_node_id'] == str(new_node)
        assert receipt['edges'][0]['to_node_id'] == str(old_node)
        async with sessions.begin() as db:
            assert await checkpoint_relation_review(db, **{**args, 'review': None}) == receipt
            edge = await db.get(Relationship, uuid.UUID(identity))
            assert edge.confidence is None and edge.strength is None
            edge.explanation = 'Human-edited callback explanation.'
        async with sessions.begin() as db:
            preserved = await checkpoint_relation_review(db, **{**args, 'batch_index': 1})
        assert preserved['edges'][0]['id'] == identity
        assert preserved['edges'][0]['disposition'] == 'existing_edges_preserved'
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            bundle = json.loads((await export_threads(str(cid), db=db)).body)
        edges = [edge for edge in bundle['edges'] if edge['relation_type'] == 'return_to_thread']
        assert len(edges) == 1 and edges[0]['from_node_id'] == str(new_node)
        assert edges[0]['to_node_id'] == str(old_node)
        assert set(edges[0]['supporting_utterance_ids']) == {str(early), str(late)}
        assert edges[0]['explanation'] == 'Human-edited callback explanation.'
        assert all(node['thread_id'] == 'borrowing' for node in bundle['graph_data'])
        async with sessions.begin() as db:
            await persist_graph(db=db, **scope, append_only=True, commit=False, existing_json=[
                {'id': str(uuid.uuid4()), 'semantic_level': 1, 'node_name': 'Overlapping moment',
                 'summary': 'Another interpretation of the same source.', 'utterance_ids': [str(early)]}])
        async with sessions() as db:
            newer = await capture_reconciliation(db, **scope)
        async with sessions.begin() as db:
            ambiguous = await checkpoint_relation_review(db, **{**args, 'snapshot': newer, 'batch_index': 2})
        assert ambiguous['edges'] == []
        assert ambiguous['mapping'][0]['disposition'] == 'ambiguous_node_ownership'
        with pytest.raises(JournalConflict, match='leaf interpretation changed'):
            async with sessions.begin() as db:
                await checkpoint_relation_review(db, **args)
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': False}}
        with pytest.raises(DeploymentPrivacyError):
            async with sessions.begin() as db:
                await checkpoint_relation_review(db, **{**args, 'snapshot': newer, 'batch_index': 3})
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
