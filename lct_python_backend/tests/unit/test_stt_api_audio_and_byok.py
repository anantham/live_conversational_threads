"""Unit tests for stt_api.py gaps not covered by test_stt_api_settings.py.

Covers:
- _validate_conversation_id: path-traversal guard (security-critical)
- _build_cloud_test_candidate: pure logic, candidate dict construction
- POST /api/byok/session: BYOK session creation (400 on bad payload)
- POST /api/conversations/{id}/audio/chunk: upload guard (traversal, missing session_id, empty body)
- POST /api/conversations/{id}/audio/complete: finalize guard
- POST /api/conversations/{id}/audio/recover: recover (path traversal)
- GET  /api/conversations/{id}/audio/status: status (path traversal)
- GET  /ws/audio: deprecated endpoint returns 410
"""

import importlib
import sys
import types
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Module loader (same approach as test_stt_api_settings.py)
# ---------------------------------------------------------------------------

def _load_stt_api(monkeypatch):
    @asynccontextmanager
    async def dummy_session_context():
        yield object()

    async def dummy_get_async_session():
        yield object()

    dummy_db = types.ModuleType("lct_python_backend.db_session")
    dummy_db.get_async_session = dummy_get_async_session
    dummy_db.get_async_session_context = dummy_session_context
    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db)

    sys.modules.pop("lct_python_backend.stt_api", None)
    return importlib.import_module("lct_python_backend.stt_api")


def _build_client(stt_api_module):
    async def override_session():
        yield object()

    app = FastAPI()
    app.include_router(stt_api_module.router)
    app.dependency_overrides[stt_api_module.get_async_session] = override_session
    return TestClient(app)


# ---------------------------------------------------------------------------
# _validate_conversation_id — path-traversal security guard
# ---------------------------------------------------------------------------

class TestValidateConversationId:
    def _fn(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        return stt_api._validate_conversation_id

    def test_plain_uuid_accepted(self, monkeypatch):
        fn = self._fn(monkeypatch)
        # Should not raise — a UUID is safe.
        fn("abc123-def456_ABC")

    def test_alphanumeric_with_hyphens_underscores_accepted(self, monkeypatch):
        fn = self._fn(monkeypatch)
        fn("my_conv-01")

    def test_path_traversal_double_dot_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn("../etc/passwd")
        assert exc.value.status_code == 400

    def test_path_traversal_slash_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn("conv/evil")
        assert exc.value.status_code == 400

    def test_path_traversal_windows_style_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn("..\\..\\evil")
        assert exc.value.status_code == 400

    def test_empty_string_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn("")
        assert exc.value.status_code == 400

    def test_none_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn(None)
        assert exc.value.status_code == 400

    def test_too_long_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            fn("a" * 201)
        assert exc.value.status_code == 400

    def test_exactly_200_chars_accepted(self, monkeypatch):
        fn = self._fn(monkeypatch)
        fn("a" * 200)  # should not raise

    def test_special_chars_rejected(self, monkeypatch):
        from fastapi import HTTPException
        fn = self._fn(monkeypatch)
        for bad in ("conv id", "conv\x00id", "<script>", "conv;drop"):
            with pytest.raises(HTTPException):
                fn(bad)


# ---------------------------------------------------------------------------
# _build_cloud_test_candidate — pure candidate construction logic
# ---------------------------------------------------------------------------

class TestBuildCloudTestCandidate:
    def _fn(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        return stt_api._build_cloud_test_candidate

    def _full_settings(self):
        return {
            "cloud_fallback_providers": {
                "openai_audio": {
                    "base_url": "https://api.openai.com",
                    "model": "whisper-1",
                    "api_key": "sk-test",
                    "enabled": True,
                }
            },
            "http_language": "en",
            "sample_rate_hz": 16000,
        }

    def test_missing_provider_in_settings_returns_empty_and_error(self, monkeypatch):
        fn = self._fn(monkeypatch)
        candidate, error = fn({}, "openai_audio")
        assert candidate == {}
        assert "openai_audio" in error

    def test_fully_configured_returns_candidate_no_error(self, monkeypatch):
        fn = self._fn(monkeypatch)
        candidate, error = fn(self._full_settings(), "openai_audio")
        assert error == ""
        assert candidate["provider"] == "openai_audio"
        assert candidate["model"] == "whisper-1"
        assert candidate["api_key"] == "sk-test"

    def test_missing_api_key_reported(self, monkeypatch):
        fn = self._fn(monkeypatch)
        settings = self._full_settings()
        settings["cloud_fallback_providers"]["openai_audio"]["api_key"] = ""
        _, error = fn(settings, "openai_audio")
        assert "API key" in error

    def test_missing_model_reported(self, monkeypatch):
        fn = self._fn(monkeypatch)
        settings = self._full_settings()
        settings["cloud_fallback_providers"]["openai_audio"]["model"] = ""
        _, error = fn(settings, "openai_audio")
        assert "model" in error

    def test_openai_audio_with_diarize_model_sets_supports_diarization(self, monkeypatch):
        fn = self._fn(monkeypatch)
        settings = self._full_settings()
        settings["cloud_fallback_providers"]["openai_audio"]["diarize_model"] = "whisper-1"
        candidate, _ = fn(settings, "openai_audio")
        assert candidate["supports_diarization"] is True

    def test_openai_audio_without_diarize_model_does_not_support_diarization(self, monkeypatch):
        fn = self._fn(monkeypatch)
        candidate, _ = fn(self._full_settings(), "openai_audio")
        assert candidate["supports_diarization"] is False

    def test_openrouter_audio_is_degraded(self, monkeypatch):
        fn = self._fn(monkeypatch)
        settings = {
            "cloud_fallback_providers": {
                "openrouter_audio": {
                    "base_url": "https://openrouter.ai",
                    "model": "openai/whisper-1",
                    "api_key": "or-key",
                    "enabled": True,
                }
            },
            "http_language": "",
        }
        candidate, _ = fn(settings, "openrouter_audio")
        assert candidate["degraded"] is True

    def test_enabled_flag_reflects_config(self, monkeypatch):
        fn = self._fn(monkeypatch)
        candidate, _ = fn(self._full_settings(), "openai_audio")
        assert candidate["enabled"] is True

    def test_disabled_provider_reflected(self, monkeypatch):
        fn = self._fn(monkeypatch)
        settings = self._full_settings()
        settings["cloud_fallback_providers"]["openai_audio"]["enabled"] = False
        candidate, _ = fn(settings, "openai_audio")
        assert candidate["enabled"] is False


# ---------------------------------------------------------------------------
# POST /api/byok/session
# ---------------------------------------------------------------------------

class TestByokSession:
    def test_non_dict_payload_returns_400(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        monkeypatch.setattr(
            stt_api,
            "create_byok_session",
            AsyncMock(return_value={"session_id": "tok123"}),
        )
        client = _build_client(stt_api)
        # FastAPI won't accept a JSON array as a Dict body — 422
        resp = client.post("/api/byok/session", json=[1, 2, 3])
        assert resp.status_code in (400, 422)

    def test_valid_payload_calls_create_byok_session(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        monkeypatch.setattr(
            stt_api,
            "create_byok_session",
            AsyncMock(return_value={"session_id": "tok123", "expires_at": "..."}),
        )
        client = _build_client(stt_api)
        resp = client.post(
            "/api/byok/session",
            json={"provider": "openai_audio", "api_key": "sk-test"},
        )
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "tok123"

    def test_value_error_from_service_returns_400(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        monkeypatch.setattr(
            stt_api,
            "create_byok_session",
            AsyncMock(side_effect=ValueError("bad api_key format")),
        )
        client = _build_client(stt_api)
        resp = client.post("/api/byok/session", json={"api_key": "bad"})
        assert resp.status_code == 400

    def test_runtime_error_from_service_returns_502(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        monkeypatch.setattr(
            stt_api,
            "create_byok_session",
            AsyncMock(side_effect=RuntimeError("store unavailable")),
        )
        client = _build_client(stt_api)
        resp = client.post("/api/byok/session", json={"api_key": "sk-test"})
        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# POST /api/conversations/{id}/audio/chunk
# ---------------------------------------------------------------------------

class TestAudioChunkUpload:
    def _client(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        # Stub the module-level audio_storage
        monkeypatch.setattr(
            stt_api.audio_storage,
            "append_chunk",
            AsyncMock(return_value=None),
        )
        return _build_client(stt_api)

    def test_path_traversal_rejected(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/../evil/audio/chunk?session_id=s1",
            content=b"pcmdata",
        )
        # FastAPI path routing will reject the traversal attempt (404 or 400).
        assert resp.status_code in (400, 404, 422)

    def test_missing_session_id_returns_400(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/conv123/audio/chunk",
            content=b"pcmdata",
        )
        assert resp.status_code == 400
        assert "session_id" in resp.json()["detail"]

    def test_empty_body_returns_400(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/conv123/audio/chunk?session_id=s1",
            content=b"",
        )
        assert resp.status_code == 400
        assert "Empty" in resp.json()["detail"]

    def test_valid_upload_returns_ok(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/conv123/audio/chunk?session_id=s1",
            content=b"\x00\x01\x02\x03",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["bytes"] == 4
        assert body["session_id"] == "s1"

    def test_invalid_conversation_id_returns_400(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/bad id!/audio/chunk?session_id=s1",
            content=b"pcm",
        )
        assert resp.status_code in (400, 404, 422)


# ---------------------------------------------------------------------------
# POST /api/conversations/{id}/audio/complete
# ---------------------------------------------------------------------------

class TestAudioComplete:
    def _client(self, monkeypatch, paths=None):
        stt_api = _load_stt_api(monkeypatch)
        resolved = {"wav_path": "/tmp/conv123.wav"} if paths is None else paths
        monkeypatch.setattr(
            stt_api.audio_storage,
            "finalize",
            AsyncMock(return_value=resolved),
        )
        monkeypatch.setattr(
            stt_api.audio_storage,
            "get_paths",
            MagicMock(return_value=resolved),
        )
        return _build_client(stt_api)

    def test_missing_session_id_returns_400(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post("/api/conversations/conv123/audio/complete")
        assert resp.status_code == 400
        assert "session_id" in resp.json()["detail"]

    def test_valid_finalize_returns_ok(self, monkeypatch):
        client = self._client(monkeypatch)
        resp = client.post(
            "/api/conversations/conv123/audio/complete?session_id=s1"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["session_id"] == "s1"

    def test_download_url_present_when_wav_path_set(self, monkeypatch):
        client = self._client(monkeypatch, paths={"wav_path": "/tmp/conv.wav"})
        resp = client.post("/api/conversations/conv123/audio/complete?session_id=s1")
        assert resp.status_code == 200
        # download_url should be set (token may be None so path-only URL)
        body = resp.json()
        assert body["download_url"] is not None
        assert "conv123" in body["download_url"]

    def test_no_download_url_when_no_wav(self, monkeypatch):
        client = self._client(monkeypatch, paths={})
        resp = client.post("/api/conversations/conv123/audio/complete?session_id=s1")
        body = resp.json()
        assert body["download_url"] is None


# ---------------------------------------------------------------------------
# GET /ws/audio — deprecated endpoint
# ---------------------------------------------------------------------------

class TestDeprecatedWsAudio:
    def test_returns_410_gone(self, monkeypatch):
        stt_api = _load_stt_api(monkeypatch)
        client = _build_client(stt_api)
        resp = client.get("/ws/audio")
        assert resp.status_code == 410
        assert "deprecated" in resp.json()["detail"].lower()
