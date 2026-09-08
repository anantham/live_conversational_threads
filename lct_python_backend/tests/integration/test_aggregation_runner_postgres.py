"""Test intent: generate all four source-backed tiers, resume after provider
failure without regenerating saved tiers, and export the complete hierarchy.
Uses real isolated PostgreSQL with synthetic source and a deterministic provider
double; it does not measure semantic model quality or HTTP authorization.
Revocation during generation must prevent commit and any later model request.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Node, Utterance
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
from lct_python_backend.services.transcript.aggregation_runner import AggregationRunner


@pytest.mark.asyncio
@pytest.mark.parametrize('revoke_during_generation', [False, True])
async def test_all_tiers_restart_and_export_without_duplicate_generation(revoke_during_generation, monkeypatch):
    url = os.getenv("PASSAGE_JOURNAL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Explicit isolated local database URL required")
    parsed = urlparse(url)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid = uuid.uuid4(), uuid.uuid4()
    owner = f"synthetic-aggregation-runner-{cid}"
    # Export now enforces the configured owner, including direct function calls.
    monkeypatch.setenv('LCT_OWNER_ID', owner)
    text = "We still need to decide who may borrow the shared key."
    calls = []
    loop = asyncio.get_running_loop()
    async def consent(allowed):
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': allowed, 'external_llm_ok': False}}
    class Envelope:
        fingerprint = "synthetic-runner-v1"
        fail_level = 3
        revoke_level = None
        providers = [{'id': 'local', 'trust_scope': 'owner_private'}]
        def complete_json(self, prompt):
            request = json.loads(prompt)
            level = request["target_level"]
            calls.append(level)
            assert request["sources"][0]["text"] == text
            if level == self.fail_level:
                raise RuntimeError("Synthetic provider unavailable")
            if level == self.revoke_level:
                asyncio.run_coroutine_threadsafe(consent(False), loop).result(timeout=10)
            citations = [{"child_id": child["id"], "utterance_id": str(uid), "quote": text}
                         for child in request["children"]]
            return SimpleNamespace(data={"nodes": [{"node_name": "Unresolved borrowing policy",
                "summary": "Permission to borrow the shared key remains undecided.",
                "children_ids": [child["id"] for child in request["children"]],
                "membership_evidence": citations}]})
    envelope = Envelope()
    def runner():
        return AggregationRunner(session_factory=sessions, conversation_id=str(cid),
                                 owner_id=owner, envelope=envelope)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name="Synthetic runner",
                conversation_type="transcript", source_type="synthetic", started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1, text=text, speaker_id="SPEAKER_00"))
        async with sessions.begin() as db:
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner, append_only=True, commit=False,
                existing_json=[{"id": str(uuid.uuid4()), "semantic_level": 1, "node_name": "Borrowing question",
                                "summary": text, "utterance_ids": [str(uid)], "thread_id": "borrowing"}])
        with pytest.raises(RuntimeError, match="Synthetic provider"):
            await runner().run_through()
        async with sessions() as db:
            nodes = (await db.execute(select(Node).where(Node.conversation_id == cid))).scalars().all()
            assert sorted(node.level for node in nodes) == [1, 2]
            saved_idea = next(str(node.id) for node in nodes if node.level == 2)
        envelope.fail_level = None
        if revoke_during_generation:
            envelope.revoke_level = 3
            with pytest.raises(DeploymentPrivacyError):
                await runner().run_through()
            async with sessions() as db:
                levels = (await db.execute(select(Node.level).where(Node.conversation_id == cid))).scalars().all()
                assert sorted(levels) == [1, 2], 'Revoked in-flight output must not commit L3'
            before = list(calls)
            with pytest.raises(DeploymentPrivacyError):
                await runner().run_through()
            assert calls == before
            await consent(True)
            envelope.revoke_level = None
        receipts = await runner().run_through()
        expected_calls = [2, 3] + ([3] if revoke_during_generation else []) + [3, 4, 5]
        assert calls == expected_calls
        assert receipts[0]["nodes"][0]["id"] == saved_idea
        assert await runner().run_through() == receipts
        assert calls == expected_calls, "Saved tiers must not invoke the provider again"
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            response = await export_threads(str(cid), db=db)
        bundle = json.loads(response.body)
        assert sorted(node["semantic_level"] for node in bundle["graph_data"]) == [1, 2, 3, 4, 5]
        for node in bundle["graph_data"]:
            assert node["utterance_ids"] == [str(uid)]
            if node["semantic_level"] > 1:
                assert node["membership_evidence"][0]["quote"] == text
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
