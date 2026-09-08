"""Source-backed thread identity acceptance using real journal/database state.

Intent: committed synthetic occurrences feed review/export/next-passage loader;
restart reuses receipts; audited speaker correction excludes stale judgments;
owner/consent rejection occurs before inference. Uncommitted future source must
never leak into pair prompts. Only inference is deterministic, no model invoked.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance, PipelineArtifact
from lct_python_backend.services.transcript.passage_journal import append_passage
from lct_python_backend.services.transcript.thread_identity_runner import (
    ThreadIdentityRunner, export_thread_identity_reviews, ARTIFACT_TYPE)
from lct_python_backend.services.transcript.thread_identity_context import ThreadIdentityContextReader, CANDIDATE_POLICY
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError


class SyntheticEnvelope:
    fingerprint = 'synthetic-thread-review-only-v1'
    providers = [{'id': 'synthetic-local', 'type': 'openai_compatible',
                  'model': 'synthetic', 'base_url': 'http://127.0.0.1:11434',
                  'trust_scope': 'owner_private'}]

    def __init__(self):
        self.requests = []

    def with_system_prompt(self, prompt):
        return self

    def validate(self, prompt):
        assert len(prompt.encode()) < 32768

    def complete_json(self, prompt):
        request = json.loads(prompt)
        self.requests.append(request)
        sources = {s['source_id']: s for s in request['sources']}
        return SimpleNamespace(data={'judgment': 'related_distinct',
            'rationale': 'Synthetic judgment for persistence acceptance, not semantic evaluation.',
            'evidence': [{'node_id': n['node_id'], 'source_id': n['source_id'],
                          'quote': sources[n['source_id']]['text']} for n in request['nodes']]})


@pytest.mark.asyncio
async def test_real_thread_review_restart_loader_source_revision_and_consent(monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database required')
    parsed = urlparse(url)
    assert parsed.hostname == '127.0.0.1' and parsed.port == 55439 and not parsed.query
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid = uuid.uuid4()
    owner = f'synthetic-thread-review-{cid}'
    scope = dict(conversation_id=str(cid), owner_id=owner)
    privacy = {'local_llm_ok': True, 'external_llm_ok': False}
    source_ids = [uuid.uuid4() for _ in range(4)]
    node_ids = [str(uuid.uuid4()) for _ in range(3)]
    texts = ['Who pays for hosting?', 'Who provides staffing?', 'Who organizes training?']
    envelope = SyntheticEnvelope()
    def runner(**overrides):
        return ThreadIdentityRunner(session_factory=sessions, **{**scope, **overrides}, envelope=envelope,
                                    candidate_policy_id=CANDIDATE_POLICY)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic thread identity',
                conversation_type='transcript', source_type='synthetic',
                started_at=datetime.now(timezone.utc), source_metadata={'privacy': privacy}))
        for index, sentence in enumerate(texts):
            chunk = str(uuid.uuid4())
            async with sessions.begin() as db:
                db.add(Utterance(id=source_ids[index], conversation_id=cid, sequence_number=index + 1,
                    text=sentence, speaker_id='SPEAKER_00', timestamp_start=index * 10.0,
                    timestamp_end=index * 10.0 + 5))
                await db.flush()
                await append_passage(db, **scope, expected_revision=index,
                    source_ids=[str(source_ids[index])], policy_fingerprint='synthetic-thread-journal-v1',
                    patch={'nodes': [{'id': node_ids[index], 'chunk_id': chunk, 'node_name': 'Inquiry',
                        'summary': sentence, 'source_excerpt': sentence, 'semantic_level': 1,
                        'thread_id': 'same-provisional-thread', 'thread_label': 'Project support'}],
                        'chunks': {chunk: sentence}, 'utterance_chunk_map': {chunk: [str(source_ids[index])]}})
        async with sessions.begin() as db:
            db.add(Utterance(id=source_ids[3], conversation_id=cid, sequence_number=4,
                text='FUTURE SYNTHETIC SOURCE NOT YET COMMITTED TO PASSAGE MEMORY.', speaker_id='SPEAKER_01'))
        first = await runner().run([node_ids[:2]])
        assert first['reviewed_pair_count'] == 1 and first['possible_pair_count'] == 3
        assert first['coverage_complete'] is False
        assert len(envelope.requests) == 1
        assert await runner().run([node_ids[:2]]) == first
        assert len(envelope.requests) == 1
        async with sessions() as db:
            state = (await runner().capture(db))['state']
        annotations = await ThreadIdentityContextReader(runner())(
            state['nodes'], state['chunks'], state['utterance_chunk_map'])
        assert len(annotations) == 3 and len(envelope.requests) == 3
        assert await ThreadIdentityContextReader(runner())(
            state['nodes'], state['chunks'], state['utterance_chunk_map']) == annotations
        assert len(envelope.requests) == 3
        for annotation in annotations:
            sources = {s['source_id']: s for s in annotation['sources']}
            assert len(annotation['pair']) == 2
            assert {n['thread_id'] for n in annotation['nodes']} == {'same-provisional-thread'}
            assert annotation['accepted_for_projection'] is False
            for evidence in annotation['evidence']:
                source = sources[evidence['source_id']]
                assert source['text'][evidence['start']:evidence['end']] == evidence['quote']
                assert str(source_ids[3]) not in source['utterance_ids']
                assert source['utterances'][0][-1] == 'SPEAKER_00'
        assert 'FUTURE SYNTHETIC' not in json.dumps(envelope.requests)
        async with sessions() as db:
            exported = await export_thread_identity_reviews(db, **scope)
            assert exported['policies'][0]['annotations'] == annotations
            rows = (await db.execute(select(PipelineArtifact).where(PipelineArtifact.conversation_id == cid,
                PipelineArtifact.artifact_type == ARTIFACT_TYPE))).scalars().all()
            assert len(rows) == 3
            with pytest.raises(PermissionError):
                await export_thread_identity_reviews(db, conversation_id=str(cid), owner_id='foreign-owner')
        with pytest.raises(PermissionError):
            await runner(owner_id='foreign-owner').run([node_ids[:2]])
        assert len(envelope.requests) == 3

        # Real supported attribution refinement, not an unaudited source mutation.
        from lct_python_backend import db_session
        from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
        monkeypatch.setattr(db_session, 'get_async_session_context', sessions)
        refinement = await persist_speaker_refinement(conversation_id=str(cid),
            source_utterance_id=str(source_ids[0]), segments=[{'speaker': 'SPEAKER_01', 'text': texts[0]}],
            provider='synthetic', model='synthetic', transport='synthetic')
        assert refinement['updated_utterances'] == 1
        async with sessions() as db:
            revised_source = await db.get(Utterance, source_ids[0])
            assert revised_source.text == texts[0] and revised_source.speaker_id == 'SPEAKER_01'
            stale = await export_thread_identity_reviews(db, **scope)
            assert stale['superseded_review_count'] == 2
            assert stale['policies'][0]['reviewed_pair_count'] == 1
            revised_state = (await runner().capture(db))['state']
        current = await ThreadIdentityContextReader(runner())(
            revised_state['nodes'], revised_state['chunks'], revised_state['utterance_chunk_map'])
        assert len(current) == 2 and len(envelope.requests) == 4
        corrected = next(a for a in current if node_ids[0] in a['pair'])
        corrected_node = next(n for n in corrected['nodes'] if n['node_id'] == node_ids[0])
        assert corrected_node['attribution_review_required'] is True
        assert corrected_node['source_attributions'][0]['current_speaker_id'] == 'SPEAKER_01'
        async with sessions.begin() as db:
            await db.execute(update(Conversation).where(Conversation.id == cid).values(
                source_metadata={'privacy': {'local_llm_ok': False, 'external_llm_ok': False}}))
        with pytest.raises(DeploymentPrivacyError):
            await runner().run([node_ids[:2]])
        assert len(envelope.requests) == 4
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
