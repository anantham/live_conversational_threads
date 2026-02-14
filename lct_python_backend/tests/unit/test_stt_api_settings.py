from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import importlib
import sys
from types import SimpleNamespace
import types
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_stt_api_with_stubs(monkeypatch):
    class PlaceholderProcessor:
        def __init__(self, *args, **kwargs):
            return None

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            return None

    @asynccontextmanager
    async def dummy_session_context():
        yield object()

    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session
    dummy_db_session.get_async_session_context = dummy_session_context

    dummy_transcript_processing = types.ModuleType(
        "lct_python_backend.services.transcript_processing"
    )
    dummy_transcript_processing.TranscriptProcessor = PlaceholderProcessor

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    monkeypatch.setitem(
        sys.modules,
        "lct_python_backend.services.transcript_processing",
        dummy_transcript_processing,
    )

    sys.modules.pop("lct_python_backend.stt_api", None)
    return importlib.import_module("lct_python_backend.stt_api")


def _build_test_client(stt_api_module, events=None):
    class DummyScalarResult:
        def __init__(self, values):
            self._values = values

        def all(self):
            return self._values

    class DummyExecuteResult:
        def __init__(self, values):
            self._values = values

        def scalars(self):
            return DummyScalarResult(self._values)

    class DummySession:
        def __init__(self, values):
            self._values = values or []

        async def execute(self, _statement):
            return DummyExecuteResult(self._values)

    async def override_session():
        yield DummySession(events or [])

    app = FastAPI()
    app.include_router(stt_api_module.router)
    app.dependency_overrides[stt_api_module.get_async_session] = override_session
    return TestClient(app)


def test_telemetry_endpoint_aggregates_metrics(monkeypatch):
    stt_api = _load_stt_api_with_stubs(monkeypatch)
    now = datetime.utcnow()

    events = [
        SimpleNamespace(
            provider="parakeet",
            received_at=now,
            event_metadata={
                "telemetry": {
                    "partial_turnaround_ms": 100,
                    "final_turnaround_ms": 220,
                    "stt_request_ms": 80,
                    "audio_decode_ms": 4,
                }
            },
        ),
        SimpleNamespace(
            provider="parakeet",
            received_at=now - timedelta(seconds=3),
            event_metadata={
                "telemetry": {
                    "partial_turnaround_ms": 140,
                    "stt_request_ms": 120,
                    "audio_decode_ms": 6,
                }
            },
        ),
        SimpleNamespace(
            provider="whisper",
            received_at=now - timedelta(seconds=5),
            event_metadata={
                "telemetry": {
                    "final_turnaround_ms": 310,
                    "stt_request_ms": 210,
                    "stt_flush_request_ms": 250,
                    "audio_decode_ms": 5,
                }
            },
        ),
    ]

    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(return_value={"provider": "parakeet", "provider_urls": {}}),
    )

    client = _build_test_client(stt_api, events=events)
    response = client.get("/api/settings/stt/telemetry?limit=500")
    assert response.status_code == 200

    payload = response.json()
    assert payload["window_size"] == 3
    assert payload["active_provider"] == "parakeet"

    parakeet = payload["providers"]["parakeet"]
    whisper = payload["providers"]["whisper"]

    assert parakeet["last_partial_ms"] == 100.0
    assert parakeet["last_final_ms"] == 220.0
    assert parakeet["avg_partial_ms"] == 120.0
    assert parakeet["avg_final_ms"] == 220.0
    assert parakeet["partial_samples"] == 2
    assert parakeet["final_samples"] == 1
    assert parakeet["last_stt_request_ms"] == 80.0
    assert parakeet["avg_stt_request_ms"] == 100.0
    assert parakeet["p95_stt_request_ms"] == 120.0
    assert parakeet["stt_request_samples"] == 2
    assert parakeet["avg_audio_decode_ms"] == 5.0
    assert parakeet["p95_audio_decode_ms"] == 6.0

    assert whisper["last_final_ms"] == 310.0
    assert whisper["avg_final_ms"] == 310.0
    assert whisper["final_samples"] == 1
    assert whisper["avg_stt_request_ms"] == 210.0
    assert whisper["p95_stt_request_ms"] == 210.0
    assert whisper["avg_stt_flush_request_ms"] == 250.0
    assert whisper["p95_stt_flush_request_ms"] == 250.0


def test_health_check_endpoint_derives_health_url_from_provider_ws(monkeypatch):
    stt_api = _load_stt_api_with_stubs(monkeypatch)

    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(
            return_value={
                "provider": "parakeet",
                "provider_urls": {"parakeet": "ws://localhost:5092/stream"},
            }
        ),
    )
    monkeypatch.setattr(
        stt_api,
        "_probe_health_url",
        lambda health_url, timeout_seconds: {
            "ok": True,
            "status_code": 200,
            "latency_ms": 11.5,
            "response_preview": {"status": "ok"},
            "error": None,
        },
    )

    client = _build_test_client(stt_api)
    response = client.post("/api/settings/stt/health-check", json={"provider": "parakeet"})
    assert response.status_code == 200

    payload = response.json()
    assert payload["provider"] == "parakeet"
    assert payload["ws_url"] == "ws://localhost:5092/stream"
    assert payload["health_url"] == "http://localhost:5092/health"
    assert payload["ok"] is True
    assert payload["status_code"] == 200
    assert payload["latency_ms"] == 11.5


def test_health_check_endpoint_prefers_provider_http_url(monkeypatch):
    stt_api = _load_stt_api_with_stubs(monkeypatch)

    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(
            return_value={
                "provider": "parakeet",
                "provider_urls": {"parakeet": "ws://localhost:43001/stream"},
                "provider_http_urls": {"parakeet": "http://localhost:5092/v1/audio/transcriptions"},
            }
        ),
    )
    monkeypatch.setattr(
        stt_api,
        "_probe_health_url",
        lambda health_url, timeout_seconds: {
            "ok": True,
            "status_code": 200,
            "latency_ms": 9.2,
            "response_preview": {"status": "ok"},
            "error": None,
        },
    )

    client = _build_test_client(stt_api)
    response = client.post("/api/settings/stt/health-check", json={"provider": "parakeet"})
    assert response.status_code == 200

    payload = response.json()
    assert payload["provider"] == "parakeet"
    assert payload["ws_url"] == "ws://localhost:43001/stream"
    assert payload["http_url"] == "http://localhost:5092/v1/audio/transcriptions"
    assert payload["health_url"] == "http://localhost:5092/health"
    assert payload["ok"] is True


def test_health_check_endpoint_rejects_invalid_provider(monkeypatch):
    stt_api = _load_stt_api_with_stubs(monkeypatch)
    client = _build_test_client(stt_api)

    response = client.post("/api/settings/stt/health-check", json={"provider": "invalid-provider"})
    assert response.status_code == 400
    assert "provider must be one of" in response.json()["detail"]


def test_health_check_endpoint_requires_provider_or_http_url(monkeypatch):
    stt_api = _load_stt_api_with_stubs(monkeypatch)

    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(return_value={"provider_urls": {}}),
    )

    client = _build_test_client(stt_api)
    response = client.post("/api/settings/stt/health-check", json={"provider": "parakeet"})
    assert response.status_code == 400
    assert "No STT URL configured" in response.json()["detail"]
