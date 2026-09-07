"""Full opt-in import contract on isolated PostgreSQL and synthetic source.

Only the provider transport/configuration is doubled. Exercise real passage
processing, source journal, runtime factory, aggregation and .threads export.
Restart must neither regenerate nodes nor replace prior canonical rows.
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
async def test_persisted_turn_to_all_tiers_export_and_restart(monkeypatch):
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
    class Result:
        def __init__(self, data):
            self.data = data
        def backend_label(self):
            return "synthetic_local"
    def provider_call(**kwargs):
        assert [p["id"] for p in kwargs["providers"]] == ["local"]
        request = json.loads(kwargs["messages"][1]["content"])
        level = request.get("target_level", 1)
        calls.append(level)
        if level == 1:
            assert request["current_passage"] == f"[SPEAKER_00]: {text}"
            return Result({"nodes": [{"node_name": "Borrowing remains undecided", "summary": text,
                "semantic_level": 1, "source_excerpt": text, "thread_id": "borrowing",
                "thread_label": "Shared key borrowing", "thread_state": "new_thread"}]})
        assert request["sources"][0]["text"] == text
        return Result({"nodes": [{"node_name": "Unresolved borrowing policy", "summary": text,
            "children_ids": [child["id"] for child in request["children"]],
            "membership_evidence": [{"child_id": child["id"], "utterance_id": str(uid), "quote": text}
                                    for child in request["children"]]}]})
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
        async with sessions() as db:
            result = await extract_graph_for_conversation(db, conversation_id=str(cid), owner_id=owner,
                                                          interleaved_runtime=config)
        assert result["node_count"] == result["auditable_node_count"] == 5
        assert result["pipeline_status"] == "reconciliation_pending"
        assert calls == [1, 2, 3, 4, 5]
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            first = json.loads((await export_threads(str(cid), db=db)).body)
        assert sorted(node["semantic_level"] for node in first["graph_data"]) == [1, 2, 3, 4, 5]
        assert first["utterances"][0]["text"] == text
        assert first["utterances"][0]["speaker_id"] == "SPEAKER_00"
        async with sessions() as db:
            retried = await extract_graph_for_conversation(db, conversation_id=str(cid), owner_id=owner,
                                                           interleaved_runtime=config)
        assert retried == result
        assert calls == [1, 2, 3, 4, 5]
        async with sessions() as db:
            second = json.loads((await export_threads(str(cid), db=db)).body)
        assert second["graph_data"] == first["graph_data"]
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
