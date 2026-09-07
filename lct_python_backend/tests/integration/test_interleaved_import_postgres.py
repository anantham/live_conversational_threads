"""Full opt-in import contract on isolated PostgreSQL and synthetic source.

Only the provider transport/configuration is doubled. Exercise real passage
processing, source journal, runtime factory, aggregation and .threads export.
Restart must neither regenerate nodes nor replace prior canonical rows.
Abstraction must execute proposal, source review, membership decision and parent
synthesis at every tier before its canonical commit; summaries alone are not enough.
Source inspection and relation review must run through the actual import entrypoint.
Question source selections and their exact quotes must survive export and restart.
Question review must retain speaker-labelled source and recover without another call.
Revoked consent must reject a captured review even when a receipt already exists.
"""
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlparse
from unittest.mock import AsyncMock
import uuid

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.import_pipeline.import_orchestrator import extract_graph_for_conversation
from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig


@pytest.mark.asyncio
@pytest.mark.parametrize('revise_first', [False, True, 'always', 'repeat'])
async def test_persisted_turn_to_all_tiers_export_and_restart(monkeypatch, revise_first):
    """Rejected grouping is revised with evidence; restart never replays rejected work."""
    url = os.getenv("PASSAGE_JOURNAL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Explicit isolated local database URL required")
    parsed = urlparse(url)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid = uuid.uuid4(), uuid.uuid4()
    owner = f"synthetic-full-import-{cid}"
    # The importer correctly ignores caller-supplied owner identity. Configure
    # this test host's owner instead of bypassing that authorization seam.
    monkeypatch.setenv("LCT_OWNER_ID", owner)
    text = "Who may borrow the spare key remains undecided."
    local = {"id": "local", "enabled": True, "model": "synthetic", "embedding_model": "synthetic",
             "trust_scope": "owner_private", "type": "openai_compatible", "base_url": "http://127.0.0.1:11434"}
    cloud = {**local, "id": "cloud", "trust_scope": "external", "base_url": "https://example.invalid"}
    from lct_python_backend.services import llm_config
    monkeypatch.setattr(llm_config, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(llm_config, "load_llm_providers", AsyncMock(return_value={"providers": [local, cloud]}))
    calls = []
    stages = []
    question_reviews = []
    class Result:
        def __init__(self, data):
            self.data = data
        def backend_label(self):
            return "synthetic_local"
    def provider_call(**kwargs):
        assert [p["id"] for p in kwargs["providers"]] == ["local"]
        request = json.loads(kwargs["messages"][1]["content"])
        if 'question_id' in request:
            question_reviews.append(request)
            source = request['sources'][0]
            span = dict(zip(source['utterance_fields'], source['utterances'][0]))
            assert span['speaker_id'] == 'SPEAKER_00'
            assert request['sources'][0]['text'][span['start']:span['end']] == text
            assert 'text' not in span
            return Result({'assessments': [{'event_id': 'event-1', 'scope': 'same_question',
                'resolution': 'not_an_answer', 'reason': 'The inquiry remains undecided.',
                'evidence_ids': ['source-0']}]})
        if 'spans' in request:
            stages.append('inspection')
            spans = request['spans']
            return Result({'reviewed_span_ids': [s['span_id'] for s in spans], 'observations': [
                {'kind': 'question', 'text': text, 'citations': [
                    {'span_id': spans[0]['span_id'], 'quote': text}]}]})
        if 'current_passage' in request:
            calls.append(1)
            stages.append('moment')
            assert request["current_passage"] == f"[SPEAKER_00]: {text}"
            return Result({"nodes": [{"node_name": "Borrowing remains undecided", "summary": text,
                "semantic_level": 1, "source_excerpt": text, "thread_id": "borrowing",
                "thread_label": "Shared key borrowing", "thread_state": "new_thread",
                "question_updates": [{"question_id": "borrowing", "action": "open",
                    "wording": "Who may borrow?", "rationale": "Explicitly undecided",
                    "evidence_line_ids": ["line-0"]},
                    {"question_id": "borrowing", "action": "clarify", "wording": "Borrowing remains undecided",
                     "rationale": "No resolution stated", "evidence_line_ids": ["line-0"]}]}]})
        if request.get('status') == 'proposal_only':
            calls.append(request['target_level'])
            stages.append('proposal')
            if 'revision' in request:
                feedback = request['revision']['membership_feedback']
                assert feedback[0]['decision'] == 'reject' and feedback[0]['citations']
            label = 'Open borrowing question' if 'revision' in request and revise_first != 'repeat' else 'Borrowing inquiry'
            if revise_first == 'always':
                label += f' scope {stages.count("proposal")}'
            return Result({'groups': [{'label': label, 'rationale': 'Unresolved borrowing policy.',
                                      'children_ids': [c['id'] for c in request['children']]}]})
        if 'source_page' in request:
            stages.append('review')
            spans = request['source_page']['spans']
            assert spans[0]['text'] == text
            ids = [s['span_id'] for s in spans]
            return Result({'reviewed_span_ids': ids, 'judgment': 'supports',
                           'rationale': 'Evidence concerns the unresolved inquiry.', 'evidence_span_ids': ids})
        if 'reviews' in request:
            stages.append('decision')
            return Result({'decision': 'reject' if revise_first == 'always' or (revise_first and stages.count('decision') == 1) else 'accept',
                'rationale': 'Scope should explicitly preserve the open question.', 'qualifications': 'Still unresolved.',
                'reviewed_ids': [r['review_id'] for r in request['reviews']],
                'evidence_ids': [e['evidence_id'] for r in request['reviews'] for e in r['evidence']]})
        stages.append('parent')
        return Result({'node_name': 'Unresolved borrowing policy', 'summary': text,
            'memberships': [{'child_id': m['child']['id'], 'evidence_ids': [m['evidence'][0]['evidence_id']]}
                            for m in request['members']]})
    monkeypatch.setattr("lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync", provider_call)
    config = InterleavedRuntimeConfig(session_factory=sessions,
        context_limits={"local": 32768, "cloud": 32768}, embedding_provider_ids=("local",))
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name="Synthetic complete import",
                conversation_type="transcript", source_type="synthetic", started_at=datetime.now(timezone.utc),
                source_metadata={"privacy": {"local_llm_ok": True, "external_llm_ok": False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1, text=text,
                             speaker_id="SPEAKER_00", timestamp_start=0, timestamp_end=3))
        if revise_first in ('always', 'repeat'):
            from lct_python_backend.services.transcript.bounded_aggregation_runner import AbstractionNeedsRevision
            for retry in range(2):
                async with sessions() as db:
                    message = '3 audited proposal attempts' if revise_first == 'always' else 'repeated an unsupported proposal'
                    with pytest.raises(AbstractionNeedsRevision, match=message):
                        await extract_graph_for_conversation(db, conversation_id=str(cid), owner_id=owner,
                                                            interleaved_runtime=config)
                if revise_first == 'always':
                    assert calls == [1, 2, 2, 2]
                    assert stages == ['moment', 'inspection'] + ['proposal', 'review', 'decision'] * 3
                else:
                    assert calls == [1, 2, 2]
                    assert stages == ['moment', 'inspection', 'proposal', 'review', 'decision', 'proposal']
            return
        async with sessions() as db:
            result = await extract_graph_for_conversation(db, conversation_id=str(cid), owner_id=owner,
                                                          interleaved_runtime=config)
        assert result["node_count"] == result["auditable_node_count"] == 5
        assert result["pipeline_status"] == "reconciliation_pending"
        assert result['source_review'] == {'review_pass_complete': True, 'unresolved_mappings': 0,
                                          'abstained_inspection_partitions': 0,
                                          'abstained_inspection_pages': 0, 'semantic_reconciliation_complete': False}
        expected_calls = [1, 2, 2, 3, 4, 5] if revise_first else [1, 2, 3, 4, 5]
        assert calls == expected_calls
        assert stages == ['moment', 'inspection'] + (['proposal', 'review', 'decision'] if revise_first else []) + ['proposal', 'review', 'decision', 'parent'] * 4
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            first = json.loads((await export_threads(str(cid), db=db)).body)
        assert sorted(node["semantic_level"] for node in first["graph_data"]) == [1, 2, 3, 4, 5]
        assert first["utterances"][0]["text"] == text
        assert first["utterances"][0]["speaker_id"] == "SPEAKER_00"
        leaf = next(n for n in first['graph_data'] if n['semantic_level'] == 1)
        assert leaf['question_updates'][0]['evidence_quote'] == text
        assert leaf['question_evidence_selections'][0]['line_ids'] == ['line-0']
        assert leaf['question_evidence_selections'][0]['end'] == len(text)
        async with sessions() as db:
            retried = await extract_graph_for_conversation(db, conversation_id=str(cid), owner_id=owner,
                                                           interleaved_runtime=config)
        assert retried == result
        assert calls == expected_calls
        assert len(stages) == (21 if revise_first else 18)
        async with sessions() as db:
            second = json.loads((await export_threads(str(cid), db=db)).body)
        assert second["graph_data"] == first["graph_data"]
        from lct_python_backend.services.transcript.question_review_runner import QuestionReviewRunner
        runner = QuestionReviewRunner(session_factory=sessions, conversation_id=str(cid), owner_id=owner,
            envelope=config.build_aggregation(conversation_id=str(cid), owner_id=owner,
                providers=[local], privacy={'local_llm_ok': True, 'external_llm_ok': False}).envelope)
        reviewed = await runner.run()
        assert reviewed['accepted_for_projection'] is False
        assert len(reviewed['receipts']) == 1
        assert await runner.run() == reviewed
        assert len(question_reviews) == 1
        async with sessions() as db:
            unchanged = json.loads((await export_threads(str(cid), db=db)).body)
        assert unchanged['graph_data'] == second['graph_data']
        from sqlalchemy import update
        from lct_python_backend.models import Node
        from lct_python_backend.services.transcript.question_review_runner import attributed_question_request
        from lct_python_backend.services.transcript.passage_journal import JournalConflict
        async with sessions.begin() as db:
            basis = await runner.capture(db)
        request = attributed_question_request(basis, 'borrowing', runner.envelope)
        async with sessions.begin() as db:
            await db.execute(update(Node).where(Node.conversation_id == cid, Node.level == 1)
                             .values(summary='A human corrected the interpretation.'))
        async with sessions.begin() as db:
            with pytest.raises(JournalConflict, match='changed during review'):
                await runner.checkpoint(db, basis, 0, request)
        assert len(question_reviews) == 1
        from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
        async with sessions.begin() as db:
            await db.execute(update(Conversation).where(Conversation.id == cid).values(
                source_metadata={'privacy': {'local_llm_ok': False, 'external_llm_ok': False}}))
        async with sessions.begin() as db:
            with pytest.raises(DeploymentPrivacyError):
                await runner.checkpoint(db, basis, 0, request)
        assert len(question_reviews) == 1
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
