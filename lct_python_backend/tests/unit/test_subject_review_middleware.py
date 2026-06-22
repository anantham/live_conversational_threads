"""Middleware-exemption tests for the subject-review surface (ADR-039 §3).

Asserts the narrow AUTH_TOKEN exemption: the subject's GET and decisions POST
bypass bearer auth (they enforce their own Google gate in-handler), while
/api/subject-review/import stays AUTH_TOKEN-gated. Uses stub routes + a minimal
app — no DB, no Google.
"""
import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_app(env_overrides: dict = None):
    env = {
        "AUTH_TOKEN": "secret123",
        "ADMIN_AUTH_TOKEN": "",
        "ENABLE_URL_IMPORT": "false",
        "MAX_JSON_BYTES": str(1024 * 1024),
        "MAX_BODY_BYTES": str(2 * 1024 * 1024),
        "RATE_LIMIT_EXPENSIVE": "50",
        "RATE_LIMIT_MUTATE": "50",
        "RATE_LIMIT_READ": "50",
    }
    if env_overrides:
        env.update(env_overrides)

    with patch.dict(os.environ, env, clear=False):
        import importlib
        import lct_python_backend.middleware as mw
        importlib.reload(mw)

        app = FastAPI()

        @app.post("/api/subject-review/import")
        async def _import():
            return {"reached": "import"}

        @app.get("/api/subject-review/{token}")
        async def _get(token: str):
            return {"reached": "get", "token": token}

        @app.post("/api/subject-review/{token}/decisions")
        async def _decisions(token: str):
            return {"reached": "decisions", "token": token}

        mw.configure_p0_security(app)
        return app


@pytest.fixture
def client():
    return TestClient(_make_app())


def test_import_requires_auth_token(client):
    # IndrasNet -> LCT import stays gated; no bearer -> 401.
    resp = client.post("/api/subject-review/import", json={})
    assert resp.status_code == 401


def test_import_passes_with_auth_token(client):
    resp = client.post(
        "/api/subject-review/import", json={},
        headers={"Authorization": "Bearer secret123"},
    )
    assert resp.status_code == 200
    assert resp.json()["reached"] == "import"


def test_get_bundle_bypasses_auth_token(client):
    # Subject's browser has no AUTH_TOKEN; the GET is exempt (Google gate is in-handler).
    resp = client.get("/api/subject-review/sometoken123")
    assert resp.status_code == 200
    assert resp.json()["reached"] == "get"


def test_decisions_post_bypasses_auth_token(client):
    resp = client.post("/api/subject-review/sometoken123/decisions", json={})
    assert resp.status_code == 200
    assert resp.json()["reached"] == "decisions"


def test_get_import_literal_is_not_exempt(client):
    # GET /api/subject-review/import must NOT be exempted (the negative lookahead).
    # No route is registered for it, but the middleware must still gate it: 401, not 404.
    resp = client.get("/api/subject-review/import")
    assert resp.status_code == 401


def test_post_token_without_decisions_is_not_exempt(client):
    # POST is only exempt on the .../decisions path, not a bare token path.
    resp = client.post("/api/subject-review/sometoken123", json={})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# ADMIN_AUTH_TOKEN-only deployment mode (AUTH_TOKEN unset) — import must still
# fail closed (codex finding #1). The subject GET/POST stay exempt in this mode.
# ---------------------------------------------------------------------------


def _admin_client():
    return TestClient(_make_app({"AUTH_TOKEN": "", "ADMIN_AUTH_TOKEN": "admintok"}))


def test_import_gated_in_admin_only_mode():
    client = _admin_client()
    resp = client.post("/api/subject-review/import", json={})
    assert resp.status_code == 401


def test_import_passes_with_admin_token_in_admin_only_mode():
    client = _admin_client()
    resp = client.post(
        "/api/subject-review/import", json={},
        headers={"Authorization": "Bearer admintok"},
    )
    assert resp.status_code == 200
    assert resp.json()["reached"] == "import"


def test_subject_get_post_still_exempt_in_admin_only_mode():
    client = _admin_client()
    assert client.get("/api/subject-review/sometoken123").status_code == 200
    assert client.post("/api/subject-review/sometoken123/decisions", json={}).status_code == 200
