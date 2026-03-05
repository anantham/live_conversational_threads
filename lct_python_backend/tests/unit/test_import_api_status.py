import importlib
import sys
import types
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_import_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.import_api", None)
    return importlib.import_module("lct_python_backend.import_api")


def _build_test_client(import_api_module):
    app = FastAPI()
    app.include_router(import_api_module.router)
    return TestClient(app)


def test_import_status_derives_local_stt_health_url_from_http_endpoint(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value={"http_url": "http://localhost:5092/v1/audio/transcriptions"}),
    )
    monkeypatch.setattr(
        import_api,
        "load_llm_config",
        AsyncMock(return_value={"base_url": "http://localhost:1234", "chat_model": "qwen3-32b", "mode": "local"}),
    )
    monkeypatch.setenv("MODAL_WHISPERX_URL", "")

    probed_urls = []

    def fake_probe_health_url(health_url, timeout_seconds):
        probed_urls.append((health_url, timeout_seconds))
        return {
            "ok": True,
            "status_code": 200,
            "latency_ms": 5.0,
            "response_preview": {"status": "ok"},
            "error": None,
        }

    monkeypatch.setattr(import_api, "probe_health_url", fake_probe_health_url)

    response = client.get("/api/import/status")
    assert response.status_code == 200

    assert ("http://localhost:5092/health", 5.0) in probed_urls
    assert all(
        not url.endswith("/v1/audio/transcriptions/health")
        for url, _timeout in probed_urls
    )


def test_import_status_runs_health_probes_via_asyncio_to_thread(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value={"http_url": "http://localhost:5092/v1/audio/transcriptions"}),
    )
    monkeypatch.setattr(
        import_api,
        "load_llm_config",
        AsyncMock(return_value={"base_url": "http://localhost:1234", "chat_model": "qwen3-32b", "mode": "local"}),
    )
    monkeypatch.setenv("MODAL_WHISPERX_URL", "")

    def fake_probe_health_url(health_url, timeout_seconds):
        return {
            "ok": True,
            "status_code": 200,
            "latency_ms": 3.2,
            "response_preview": {"status": "ok"},
            "error": None,
        }

    monkeypatch.setattr(import_api, "probe_health_url", fake_probe_health_url)

    to_thread_calls = []

    async def fake_to_thread(func, *args, **kwargs):
        to_thread_calls.append((func, args, kwargs))
        return func(*args, **kwargs)

    monkeypatch.setattr(import_api.asyncio, "to_thread", fake_to_thread)

    response = client.get("/api/import/status")
    assert response.status_code == 200
    assert len(to_thread_calls) == 2  # local STT + LLM (Modal disabled for this test)
    assert all(call[0] is fake_probe_health_url for call in to_thread_calls)
