"""
Tests for P0 security middleware.

Tests auth, rate limiting, body size limits, and URL import gating.
Uses a minimal FastAPI test app to avoid importing the full backend.
"""

import os
import pytest
from unittest.mock import patch
from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

# We need to set env vars BEFORE importing middleware
# so the module-level constants pick them up.


def _make_app(env_overrides: dict = None):
    """Create a fresh test app with middleware applied under given env."""
    env = {
        "AUTH_TOKEN": "",
        "ENABLE_URL_IMPORT": "false",
        "MAX_JSON_BYTES": str(1024),  # 1 KB for testing
        "MAX_BODY_BYTES": str(2048),  # 2 KB for testing
        "RATE_LIMIT_EXPENSIVE": "3",
        "RATE_LIMIT_MUTATE": "5",
        "RATE_LIMIT_READ": "10",
    }
    if env_overrides:
        env.update(env_overrides)

    with patch.dict(os.environ, env, clear=False):
        # Re-import to pick up env changes
        import importlib
        import lct_python_backend.middleware as mw
        importlib.reload(mw)

        app = FastAPI()

        @app.get("/health")
        async def health():
            return {"status": "ok"}

        @app.get("/api/conversations")
        async def list_conversations():
            return {"conversations": []}

        @app.post("/api/conversations/123/themes/generate")
        async def generate_themes():
            return {"themes": []}

        @app.put("/api/settings/llm")
        async def update_llm():
            return {"status": "updated"}

        @app.post("/api/import/from-url")
        async def import_from_url():
            return {"status": "imported"}

        @app.websocket("/ws/transcripts")
        async def ws_transcripts(websocket: WebSocket):
            if not mw.check_ws_auth(websocket):
                await websocket.close(code=4401, reason="Unauthorized")
                return
            await websocket.accept()
            data = await websocket.receive_text()
            await websocket.send_text(f"echo: {data}")
            await websocket.close()

        mw.configure_p0_security(app)

        return app


# ---------------------------------------------------------------------------
# Auth tests
# ---------------------------------------------------------------------------


class TestAuthMiddleware:
    def test_health_bypasses_auth(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_auth_required_when_token_set(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        resp = client.get("/api/conversations")
        assert resp.status_code == 401
        assert "authorization" in resp.json()["detail"].lower()

    def test_auth_passes_with_valid_token(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        resp = client.get(
            "/api/conversations",
            headers={"Authorization": "Bearer secret123"},
        )
        assert resp.status_code == 200

    def test_auth_rejects_wrong_token(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        resp = client.get(
            "/api/conversations",
            headers={"Authorization": "Bearer wrong"},
        )
        assert resp.status_code == 401

    def test_auth_rejects_malformed_header(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        resp = client.get(
            "/api/conversations",
            headers={"Authorization": "Basic abc123"},
        )
        assert resp.status_code == 401

    def test_no_auth_when_token_unset(self):
        app = _make_app({"AUTH_TOKEN": ""})
        client = TestClient(app)
        resp = client.get("/api/conversations")
        assert resp.status_code == 200

    def test_ws_auth_rejects_without_token(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        with pytest.raises(Exception):
            # WebSocket should close with 4401
            with client.websocket_connect("/ws/transcripts"):
                pass

    def test_ws_auth_passes_with_token(self):
        app = _make_app({"AUTH_TOKEN": "secret123"})
        client = TestClient(app)
        with client.websocket_connect("/ws/transcripts?token=secret123") as ws:
            ws.send_text("hello")
            data = ws.receive_text()
            assert data == "echo: hello"


# ---------------------------------------------------------------------------
# URL import gate tests
# ---------------------------------------------------------------------------


class TestUrlImportGate:
    def test_from_url_blocked_by_default(self):
        app = _make_app({"ENABLE_URL_IMPORT": "false"})
        client = TestClient(app)
        resp = client.post("/api/import/from-url")
        assert resp.status_code == 403
        assert "disabled" in resp.json()["detail"].lower()

    def test_from_url_allowed_when_enabled(self):
        app = _make_app({"ENABLE_URL_IMPORT": "true"})
        client = TestClient(app)
        resp = client.post("/api/import/from-url")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Body size limit tests
# ---------------------------------------------------------------------------


class TestBodySizeLimits:
    def test_json_body_within_limit(self):
        app = _make_app({"MAX_JSON_BYTES": "1024"})
        client = TestClient(app)
        resp = client.put(
            "/api/settings/llm",
            json={"mode": "local"},
        )
        assert resp.status_code == 200

    def test_json_body_exceeds_limit(self):
        app = _make_app({"MAX_JSON_BYTES": "50"})  # 50 bytes
        client = TestClient(app)
        resp = client.put(
            "/api/settings/llm",
            json={"data": "x" * 100},
            headers={"Content-Length": "200"},
        )
        assert resp.status_code == 413

    def test_non_json_body_uses_larger_limit(self):
        app = _make_app({"MAX_BODY_BYTES": "10240", "MAX_JSON_BYTES": "50"})
        client = TestClient(app)
        resp = client.put(
            "/api/settings/llm",
            content=b"x" * 100,
            headers={"Content-Type": "application/octet-stream", "Content-Length": "100"},
        )
        # Should pass the size check (100 < 10240) even though > JSON limit
        # (endpoint may fail on parsing, but middleware should let it through)
        assert resp.status_code != 413


# ---------------------------------------------------------------------------
# Rate limit tests
# ---------------------------------------------------------------------------


class TestRateLimiting:
    def test_expensive_endpoint_rate_limited(self):
        app = _make_app({"RATE_LIMIT_EXPENSIVE": "2"})
        client = TestClient(app)

        # First two should succeed
        for _ in range(2):
            resp = client.post("/api/conversations/123/themes/generate")
            assert resp.status_code == 200

        # Third should be rate limited
        resp = client.post("/api/conversations/123/themes/generate")
        assert resp.status_code == 429
        assert "expensive" in resp.json()["detail"].lower()

    def test_read_endpoint_higher_limit(self):
        app = _make_app({"RATE_LIMIT_READ": "5"})
        client = TestClient(app)

        for _ in range(5):
            resp = client.get("/api/conversations")
            assert resp.status_code == 200

        resp = client.get("/api/conversations")
        assert resp.status_code == 429

    def test_health_not_rate_limited(self):
        app = _make_app({"RATE_LIMIT_READ": "1"})
        client = TestClient(app)

        # Health should never be rate limited
        for _ in range(10):
            resp = client.get("/health")
            assert resp.status_code == 200
