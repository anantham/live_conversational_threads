"""BYOK session overlay coverage for POST /api/import/process-file."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import lct_python_backend.services.byok_session_store as byok
from lct_python_backend.tests.unit.import_api_test_support import (
    build_test_client,
    load_import_api_with_stubs,
    parse_sse_events,
)

def test_process_file_uses_byok_session_for_openai_import(monkeypatch):
    import lct_python_backend.services.byok_session_store as byok

    byok._BYOK_SESSIONS.clear()
    monkeypatch.setattr(byok, "validate_byok_api_key", AsyncMock(return_value=None))
    session_payload = asyncio.run(
        byok.create_byok_session(
            provider="openai_audio",
            api_key="sk-byok-secret",
            scopes=[byok.BYOK_SCOPE_STT_IMPORT, byok.BYOK_SCOPE_LLM_IMPORT],
        )
    )

    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    stt_settings = {
        "provider": "whisper",
        "local_only": True,
        "live_cloud_fallback_enabled": False,
        "provider_http_urls": {
            "whisper": "http://100.81.65.74:7777/api/transcribe",
        },
        "http_url": "http://100.81.65.74:7777/api/transcribe",
        "cloud_fallback_providers": {},
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    transcribe_mock = AsyncMock(
        return_value=SimpleNamespace(
            transcript_text="hello from byok",
            source_type="audio",
            metadata={"provider": "openai_audio", "stt_backend": "cloud_openai_audio"},
        )
    )
    monkeypatch.setattr(import_api, "transcribe_uploaded_file", transcribe_mock)
    processor_init = {}

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, providers=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}
            processor_init["llm_config"] = llm_config or {}
            processor_init["providers"] = list(providers or [])
            processor_init["kwargs"] = kwargs

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "hello from byok"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        data={"byok_session_token": session_payload["byok_session_token"]},
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    kwargs = transcribe_mock.await_args.kwargs
    runtime_stt_settings = kwargs["stt_settings"]
    openai_provider = runtime_stt_settings["cloud_fallback_providers"]["openai_audio"]
    assert kwargs["provider_override"] == "openai_audio"
    assert runtime_stt_settings["local_only"] is False
    assert runtime_stt_settings["live_cloud_fallback_enabled"] is True
    assert openai_provider["enabled"] is True
    assert openai_provider["api_key"] == "sk-byok-secret"
    assert processor_init["llm_config"]["mode"] == "local"
    assert (
        processor_init["llm_config"]["backend"]
        == f"openai_{byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL}"
    )
    assert processor_init["providers"] == [
        {
            "id": byok.BYOK_LLM_PROVIDER_ID,
            "name": "BYOK OpenAI",
            "type": "openai",
            "base_url": byok.DEFAULT_OPENAI_BASE_URL,
            "model": byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL,
            "api_key": "sk-byok-secret",
            "enabled": True,
            "timeout_seconds": byok.DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS,
            "session_scoped": True,
        }
    ]

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["telemetry"]["llm_backend"] == f"openai_{byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL}"
    assert done_payload["telemetry"]["stt_candidate_provider"] == "openai_audio"
    assert done_payload["telemetry"]["stt_candidate_transport"] == "openai_audio"
