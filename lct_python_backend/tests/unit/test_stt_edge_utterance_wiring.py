"""Test intent: finalized live turns retain exact persisted ID/text pairs;
the final flush tail follows the same path; edge authoring refuses remote-only
providers and passes only local providers plus exact turns to the shared scan.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from lct_python_backend.services import edge_enrichment
from lct_python_backend.services.stt import stt_ws_session


@pytest.mark.asyncio
@pytest.mark.parametrize("process_final", [True, False])
async def test_final_event_retains_persisted_id_and_text(monkeypatch, process_final):
    session = stt_ws_session.WsSessionContext.__new__(stt_ws_session.WsSessionContext)
    session.session_final_text_parts = []
    session.session = SimpleNamespace(commit=AsyncMock())
    session.state = SimpleNamespace(provider="parakeet", speaker_id="speaker-1")
    session.telemetry_state = {}
    session.websocket = object()
    session._queue_active_draft_for_replacement = lambda _text: None
    session._record_observability_event = lambda **_kwargs: None
    session._record_durable_session_event = AsyncMock()
    seen_processor = []

    async def process(text, **kwargs):
        seen_processor.append((text, kwargs["utterance_id"]))

    session._run_processor_final = process
    session._track_processor_final_task = lambda task: seen_tasks.append(task)
    seen_tasks = []
    event = SimpleNamespace(utterance_id="turn-1")
    monkeypatch.setattr(stt_ws_session, "persist_transcript_event", AsyncMock(return_value=event))
    monkeypatch.setattr(stt_ws_session, "should_run_consumption_match", lambda: False)
    monkeypatch.setattr(stt_ws_session, "should_run_live_prayer", lambda: False)

    result = await session._persist_event("final", "  exact words  ", process_final=process_final)
    await asyncio.gather(*seen_tasks)

    assert result is event
    session.session.commit.assert_awaited_once()
    assert session.session_final_text_parts == [{"id": "turn-1", "text": "exact words"}]
    assert seen_processor == ([("exact words", "turn-1")] if process_final else [])


@pytest.mark.asyncio
async def test_failed_final_commit_does_not_offer_unpersisted_text(monkeypatch):
    session = stt_ws_session.WsSessionContext.__new__(stt_ws_session.WsSessionContext)
    session.session_final_text_parts = []
    session.session = SimpleNamespace(commit=AsyncMock(side_effect=RuntimeError("commit failed")))
    session.state = SimpleNamespace(provider="parakeet", speaker_id="speaker-1")
    session.telemetry_state = {}
    session._queue_active_draft_for_replacement = lambda _text: None
    monkeypatch.setattr(
        stt_ws_session, "persist_transcript_event",
        AsyncMock(return_value=SimpleNamespace(utterance_id="uncommitted-turn")),
    )

    with pytest.raises(RuntimeError, match="commit failed"):
        await session._persist_event("final", "uncommitted words", process_final=False)

    assert session.session_final_text_parts == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider,privacy",
    [
        ({"id": "remote", "base_url": "https://api.example.test", "trust_scope": "owner_private"},
         {"local_llm_ok": True}),
        ({"id": "untrusted-local", "base_url": "http://127.0.0.1:1234"},
         {"local_llm_ok": True}),
        ({"id": "external-localhost", "base_url": "http://127.0.0.1:1234", "trust_scope": "external"},
         {"local_llm_ok": True}),
        ({"id": "unconsented-local", "base_url": "http://127.0.0.1:1234", "trust_scope": "owner_private"},
         {}),
    ],
)
async def test_edge_scan_refuses_unpermitted_provider_without_calling_model(
    monkeypatch, provider, privacy,
):
    session = stt_ws_session.WsSessionContext.__new__(stt_ws_session.WsSessionContext)
    session.processor = SimpleNamespace(existing_json=[{"id": "node-1"}])
    session._runtime_llm_providers = [provider]
    session.session_final_text_parts = [{"id": "turn-1", "text": "private words"}]
    session.state = SimpleNamespace(metadata={"privacy": privacy})
    session.websocket = object()
    session._record_observability_event = lambda **_kwargs: None
    emitted = []

    async def send(_websocket, payload):
        emitted.append(payload)

    model_call = AsyncMock(side_effect=AssertionError("remote model must not be called"))
    monkeypatch.setattr(stt_ws_session, "_safe_send_json", send)
    monkeypatch.setattr(edge_enrichment, "run_edge_enrichment", model_call)

    await session._run_edge_enrichment_locked()

    model_call.assert_not_awaited()
    assert session.processor.existing_json == [{"id": "node-1"}]
    assert emitted[0]["context"]["reason"] == "no_privacy_eligible_local_provider"


@pytest.mark.asyncio
async def test_edge_scan_passes_exact_turns_only_to_local_provider(monkeypatch):
    session = stt_ws_session.WsSessionContext.__new__(stt_ws_session.WsSessionContext)
    session.processor = SimpleNamespace(existing_json=[{"id": "node-1", "node_name": "A"}])
    local = {"id": "local", "base_url": "http://127.0.0.1:1234", "trust_scope": "owner_private"}
    remote = {"id": "remote", "base_url": "https://api.example.test"}
    session._runtime_llm_providers = [remote, local]
    session.session_final_text_parts = [
        {"id": "turn-1", "text": "exact words"},
        {"id": None, "text": "unlinked words"},
    ]
    session.state = SimpleNamespace(metadata={"source_metadata": {"privacy": {"local_llm_ok": True}}})
    session.websocket = object()
    session._record_observability_event = lambda **_kwargs: None
    model_call = AsyncMock(return_value=([], {"edges_emitted": 0, "total_ms": 0}))
    monkeypatch.setattr(stt_ws_session, "_safe_send_json", AsyncMock())
    monkeypatch.setattr(edge_enrichment, "run_edge_enrichment", model_call)

    await session._run_edge_enrichment_locked()

    assert model_call.await_args.kwargs["providers"] == [local]
    assert model_call.await_args.kwargs["utterances"] == [
        {"id": "turn-1", "text": "exact words"}
    ]
