"""Test intent: full inspection -> retrieval -> relation review -> canonical
edge export with durable restart that skips saved embedding/generation work.
Both focal-to-candidate and candidate-to-focal directions survive persistence.
An omitted comparison is checkpointed before an interruption and not regenerated.
Real isolated PostgreSQL, synthetic source and doubled provider transports.
"""
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.inspection_relations import RELATION_PROMPT
from lct_python_backend.services.transcript.reconciliation_runner import ReconciliationRunner
from lct_python_backend.services.transcript.semantic_candidates import SemanticCandidates
from lct_python_backend.services.transcript.source_inspection import INSPECTION_PROMPT


@pytest.mark.asyncio
@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('omit_first', [False, True])
async def test_full_review_loop_restart_and_export(monkeypatch, reverse, omit_first):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, first, second, old, new = [uuid.uuid4() for _ in range(5)]
    owner = f'synthetic-review-loop-{cid}'
    texts = ['Who may borrow the key?', 'Returning to borrowing: the question remains open.']
    calls = {'inspection': 0, 'review': 0, 'embedding': 0}
    fail = {'later': True}
    omissions = []
    def transport(**kwargs):
        request = json.loads(kwargs['messages'][1]['content'])
        if 'spans' in request:
            calls['inspection'] += 1
            return SimpleNamespace(data={'reviewed_span_ids': [span['span_id'] for span in request['spans']],
                'observations': [{'kind': 'context', 'text': span['text'],
                    'citations': [{'span_id': span['span_id'], 'quote': span['text']}]}
                    for span in request['spans']]})
        calls['review'] += 1
        focal = request['focal']
        later = focal['text'].startswith('Returning')
        if later and omit_first and not omissions:
            omissions.append(1)
            return SimpleNamespace(data={'comparisons': []})
        if later and fail['later']:
            raise RuntimeError('Synthetic relation provider interrupted')
        comparisons = []
        for candidate in request['candidates']:
            relations = []
            if later:
                relations = [{'relation_type': 'asks' if reverse else 'return_to_thread',
                    'rationale': 'Question concerns the statement.' if reverse else 'Explicit unresolved callback.',
                    'from_observation_id': candidate['id'] if reverse else focal['id'],
                    'to_observation_id': focal['id'] if reverse else candidate['id'],
                    'node_selections': [{'observation_id': obs['id'],
                        'node_id': obs['canonical_candidates'][0]['id'],
                        'rationale': 'The canonical leaf expresses this source-backed observation.'}
                        for obs in (focal, candidate)],
                    'evidence': [{'observation_id': obs['id'], 'utterance_id': obs['source_excerpts'][0]['utterance_id'],
                                  'quote': obs['source_excerpts'][0]['text']} for obs in (focal, candidate)]}]
            comparisons.append({'candidate_id': candidate['id'], 'status': 'related' if later else 'uncertain',
                'reason': 'Explicit callback.' if later else 'No source-supported relation in this direction.',
                'relations': relations})
        return SimpleNamespace(data={'comparisons': comparisons})
    async def embed(texts, **kwargs):
        calls['embedding'] += 1
        return [[1., 0.] for _ in texts]
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    provider = {'id': 'local', 'trust_scope': 'owner_private', 'context_tokens': 16000, 'embedding_model': 'synthetic'}
    privacy = {'local_llm_ok': True, 'external_llm_ok': False}
    def envelope(prompt):
        return InferenceEnvelope(system_prompt=prompt, providers=[provider], privacy=privacy,
                                 output_tokens=1024, headroom_tokens=256)
    def runner():
        return ReconciliationRunner(session_factory=sessions, conversation_id=str(cid), owner_id=owner,
            inspection_envelope=envelope(INSPECTION_PROMPT), review_envelope=envelope(RELATION_PROMPT),
            retriever=SemanticCandidates(providers=[provider], privacy=privacy, embed_batch=embed))
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic review loop',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': privacy}))
            await db.flush()
            for uid, seq, text in zip((first, second), (1, 90), texts):
                db.add(Utterance(id=uid, conversation_id=cid, sequence_number=seq, text=text, speaker_id='A'))
        async with sessions.begin() as db:
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner, append_only=True, commit=False,
                existing_json=[{'id': str(nid), 'semantic_level': 1, 'node_name': text,
                    'summary': text, 'utterance_ids': [str(uid)], 'thread_id': 'borrowing'}
                    for nid, uid, text in zip((old, new), (first, second), texts)])
        with pytest.raises(RuntimeError, match='provider interrupted'):
            await runner().run()
        assert calls['inspection'] == 1 and calls['review'] == 2 + int(omit_first)
        fail['later'] = False
        result = await runner().run()
        assert calls['inspection'] == 1 and calls['review'] == 3 + int(omit_first)
        assert len(result['receipts'][1]['review']['coverage_attempts']) == 1 + int(omit_first)
        assert result['review_pass_complete'] and result['unresolved_mappings'] == 0
        assert not result['semantic_reconciliation_complete']
        assert result['receipts'][1]['mapping'][0]['disposition'] == 'semantic_selection'
        before = dict(calls)
        assert await runner().run() == result
        assert calls == before, 'Restarted saved pass must invoke neither embeddings nor generation'
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            bundle = json.loads((await export_threads(str(cid), db=db)).body)
        edges = [edge for edge in bundle['edges'] if edge['relation_type'] == ('asks' if reverse else 'return_to_thread')]
        assert len(edges) == 1
        assert edges[0]['from_node_id'] == str(old if reverse else new)
        assert edges[0]['to_node_id'] == str(new if reverse else old)
        assert [u['text'] for u in bundle['utterances']] == texts
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
