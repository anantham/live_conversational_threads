"""HTTP-level test for POST /api/import/turns via FastAPI TestClient + real Postgres.

Closes the gap the unit + persist_turns tests left: an ACTUAL HTTP round-trip
through FastAPI's request binding (→ 422 on contract violations), the persist
gate (→ 400), and the happy path (→ 200 + ImportStatusResponse shape). Skipped
unless DATABASE_URL is set; creates + cascade-cleans its own ITEST-EP-* rows.

Test Intent:
- Exercise request validation and persistence through the public HTTP route.
- Keep one context-managed TestClient portal for the module so the lazily
  created asyncpg engine is never reused from a different event loop.
- Preserve the fail-closed privacy and raw-retention response contracts.
- Cascade-clean every successfully persisted integration conversation.
"""

import os
import uuid
from contextlib import asynccontextmanager

import pytest

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


@pytest.fixture(scope="module")
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from lct_python_backend.import_api import router

    @asynccontextmanager
    async def lifespan(_app):
        yield
        # The real route uses the process-global lazy async engine. Dispose its
        # pool while TestClient's portal loop is still alive so Windows/asyncpg
        # does not leave transports attached to a closed loop at module exit.
        from lct_python_backend.db_session import get_engine

        await get_engine().dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


def _turn(seq):
    return {
        "seq": seq,
        "source_identifier": f"itest-ep:{seq}",
        "speaker_id": "S0",
        "text": f"turn {seq}",
    }


def _body(group_id, turns, **kw):
    body = dict(
        contract_version="1",
        group_id=group_id,
        conversation_name="endpoint test",
        source_type="google_meet",
        owner_id="usr_aditya",
        privacy={"redaction_applied": True},
        turns=turns,
    )
    body.update(kw)
    return body


def _cleanup(group_id):
    import sqlalchemy

    engine = sqlalchemy.create_engine(DATABASE_URL)
    with engine.begin() as conn:
        conn.execute(
            sqlalchemy.text(
                "DELETE FROM conversations WHERE indrasnet_group_id = :g"
            ),
            {"g": group_id},
        )
    engine.dispose()


def test_post_turns_happy_path_200(client):
    gid = f"ITEST-EP-{uuid.uuid4().hex[:10]}"
    try:
        resp = client.post("/api/import/turns", json=_body(gid, [_turn(0), _turn(1)]))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success"] is True
        assert data["utterance_count"] == 2
        assert data["conversation_id"]
    finally:
        _cleanup(gid)


def test_post_turns_gappy_seq_returns_422(client):
    # contract violation (seq 0,2) → Pydantic model_validator → FastAPI 422
    resp = client.post(
        "/api/import/turns", json=_body("ITEST-EP-bad", [_turn(0), _turn(2)])
    )
    assert resp.status_code == 422, resp.text


def test_post_turns_missing_privacy_returns_422(client):
    body = _body("ITEST-EP-bad2", [_turn(0)])
    del body["privacy"]  # privacy is required (fail-closed)
    resp = client.post("/api/import/turns", json=body)
    assert resp.status_code == 422, resp.text


def test_post_turns_raw_text_personal_private_returns_200(client, monkeypatch):
    # ADR-063 retired LCT_MIRROR_RAW for owner-operated personal deployments.
    # Explicit owner_local_raw remains required by the request contract.
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "personal_private")
    monkeypatch.delenv("LCT_MIRROR_RAW", raising=False)
    gid = f"ITEST-EP-raw-private-{uuid.uuid4().hex[:10]}"
    try:
        body = _body(
            gid, [_turn(0)], privacy={"redaction_applied": False}, owner_local_raw=True
        )
        resp = client.post("/api/import/turns", json=body)
        assert resp.status_code == 200, resp.text
        assert resp.json()["utterance_count"] == 1
    finally:
        _cleanup(gid)


def test_post_turns_raw_text_hosted_shared_returns_400(client, monkeypatch):
    # The retired escape hatch cannot override the hosted/shared fail-closed
    # boundary. The public route must map DeploymentPrivacyError to HTTP 400.
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    monkeypatch.setenv("LCT_MIRROR_RAW", "1")
    gid = f"ITEST-EP-raw-hosted-{uuid.uuid4().hex[:10]}"
    try:
        body = _body(
            gid, [_turn(0)], privacy={"redaction_applied": False}, owner_local_raw=True
        )
        resp = client.post("/api/import/turns", json=body)
        assert resp.status_code == 400, resp.text
        assert "raw transcript retention is disabled" in resp.json()["detail"]
    finally:
        _cleanup(gid)
