"""CORS-on-error-response tests (ISSUES.md: auth-reject CORS masking).

A 401 from AuthMiddleware short-circuits the request before it reaches the app.
Because CORSMiddleware is the OUTERMOST middleware (added last in backend.py, after
``configure_p0_security``), that reject still passes back out through CORS and
carries ``Access-Control-Allow-Origin`` — so the browser reads the real "401 Unauthorized"
instead of a misleading "CORS / backend unreachable". These tests lock in that
behaviour and the required middleware order.
"""
import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

ORIGIN = "https://threads.example.com"


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
        import lct_python_backend.auth_policy as auth_policy
        import lct_python_backend.body_limits as body_limits
        import lct_python_backend.rate_limit as rate_limit
        import lct_python_backend.url_import_gate as url_import_gate
        import lct_python_backend.middleware as mw
        importlib.reload(auth_policy)
        importlib.reload(body_limits)
        importlib.reload(rate_limit)
        importlib.reload(url_import_gate)
        importlib.reload(mw)

        app = FastAPI()

        @app.get("/api/conversations")
        async def _protected():
            return {"ok": True}

        # Mirror backend.py's assembly: the P0 security stack first, then CORS added
        # LAST so it is the OUTERMOST middleware (add_middleware prepends).
        mw.configure_p0_security(app)
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[ORIGIN],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        return app


@pytest.fixture
def client():
    return TestClient(_make_app())


def test_401_reject_still_carries_cors_header(client):
    # No bearer -> AuthMiddleware 401. The reject must carry ACAO so the browser reads
    # "401 Unauthorized" rather than a masked "CORS / unreachable" network error.
    resp = client.get("/api/conversations", headers={"Origin": ORIGIN})
    assert resp.status_code == 401
    assert resp.headers.get("access-control-allow-origin") == ORIGIN


def test_valid_token_authorized_and_cors_present(client):
    resp = client.get(
        "/api/conversations",
        headers={"Origin": ORIGIN, "Authorization": "Bearer secret123"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert resp.headers.get("access-control-allow-origin") == ORIGIN


def test_cors_preflight_bypasses_auth(client):
    # OPTIONS preflight is handled by CORS and must not be 401'd by auth.
    resp = client.options(
        "/api/conversations",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert resp.status_code in (200, 204)
    assert resp.headers.get("access-control-allow-origin") == ORIGIN


def test_disallowed_origin_gets_no_cors_header(client):
    # A non-allowlisted origin must NOT receive ACAO — the allowlist still holds even
    # though the reject now flows through CORS.
    resp = client.get(
        "/api/conversations",
        headers={"Origin": "https://evil.example.com"},
    )
    assert resp.status_code == 401
    assert resp.headers.get("access-control-allow-origin") is None
