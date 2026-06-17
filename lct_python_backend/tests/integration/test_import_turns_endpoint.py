"""HTTP-level test for POST /api/import/turns via FastAPI TestClient + real Postgres.

Closes the gap the unit + persist_turns tests left: an ACTUAL HTTP round-trip
through FastAPI's request binding (→ 422 on contract violations), the persist
gate (→ 400), and the happy path (→ 200 + ImportStatusResponse shape). Skipped
unless DATABASE_URL is set; creates + cascade-cleans its own ITEST-EP-* rows.
"""

import os
import uuid

import pytest

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from lct_python_backend.import_api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


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


def test_post_turns_happy_path_200():
    client = _client()
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


def test_post_turns_gappy_seq_returns_422():
    # contract violation (seq 0,2) → Pydantic model_validator → FastAPI 422
    resp = _client().post(
        "/api/import/turns", json=_body("ITEST-EP-bad", [_turn(0), _turn(2)])
    )
    assert resp.status_code == 422, resp.text


def test_post_turns_missing_privacy_returns_422():
    body = _body("ITEST-EP-bad2", [_turn(0)])
    del body["privacy"]  # privacy is required (fail-closed)
    resp = _client().post("/api/import/turns", json=body)
    assert resp.status_code == 422, resp.text


def test_post_turns_raw_text_without_mirror_raw_returns_400(monkeypatch):
    # passes Pydantic (owner_local_raw=true), but persist_turns refuses without
    # LCT_MIRROR_RAW → ValueError → endpoint maps to 400.
    monkeypatch.delenv("LCT_MIRROR_RAW", raising=False)
    gid = "ITEST-EP-raw"
    try:
        body = _body(
            gid, [_turn(0)], privacy={"redaction_applied": False}, owner_local_raw=True
        )
        resp = _client().post("/api/import/turns", json=body)
        assert resp.status_code == 400, resp.text
    finally:
        _cleanup(gid)
