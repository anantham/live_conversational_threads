"""Route-level tests for GET /api/version + its auth exemption."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import auth_policy
from lct_python_backend.version_api import router


def test_version_endpoint_returns_payload():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    resp = client.get("/api/version")
    assert resp.status_code == 200
    data = resp.json()
    assert data["service"] == "lct_backend"
    for key in ("git_sha", "python_executable", "canonical_python", "pid", "started_at"):
        assert key in data


def test_version_path_is_auth_exempt():
    # /api/version is in HEALTH_PATHS, so AuthMiddleware lets it through without a
    # token (`if auth.is_health(path): return await call_next(request)`).
    assert auth_policy.is_health("/api/version") is True
    assert auth_policy.is_health("/api/version/") is True  # trailing slash normalised
    # sanity: a non-exempt path is still gated.
    assert auth_policy.is_health("/api/conversations") is False


def test_version_reachable_without_token_through_auth_middleware(monkeypatch):
    """End-to-end: with AUTH_TOKEN set, /api/version is served WITHOUT a token
    (the whole point — bare curl can answer 'is the merged code live?'), while a
    non-exempt path still 401s."""
    from lct_python_backend.middleware import AuthMiddleware

    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", "secret-token")
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(router)

    @app.get("/api/conversations")
    async def _gated():
        return {"ok": True}

    client = TestClient(app)
    assert client.get("/api/version").status_code == 200  # exempt, no token
    assert client.get("/api/conversations").status_code == 401  # gated
