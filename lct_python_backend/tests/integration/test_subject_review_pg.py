"""Endpoint + state-machine tests for the subject-review surface (ADR-039 P2a).

Real HTTP round-trip (FastAPI TestClient) against the real Postgres dev DB, with
Google verification and the IndrasNet relay mocked. Covers: import validation +
storage (token never returned), the Google email gate (GET + POST), the
token-never-served canary, exact-set-equality + redact_span rejection, the
immutable-hash idempotency state machine (same-hash idempotent, different-hash
409, relay-failed-then-retry), and the post-relay scrub.

Skipped unless DATABASE_URL is set; creates the table if absent and cleans its
own ITEST-SR-* rows.
"""
import json
import os
import uuid

import pytest

DATABASE_URL = os.getenv("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

RUN_PREFIX = "ITEST-SR-"

_DDL = """
CREATE TABLE IF NOT EXISTS subject_review_bundles (
    token TEXT PRIMARY KEY,
    prayer_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    callback_token TEXT,
    subject_email TEXT NOT NULL,
    subject_name TEXT,
    items_json TEXT,
    decisions_json TEXT,
    decision_hash TEXT,
    relay_result TEXT,
    relay_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    submitted_at TIMESTAMP,
    relayed_at TIMESTAMP,
    expires_at TIMESTAMP,
    revoked_at TIMESTAMP,
    CONSTRAINT ck_subject_review_bundles_status
        CHECK (status IN ('pending', 'submitted', 'relayed', 'failed'))
)
"""


def _sync_engine():
    import sqlalchemy
    return sqlalchemy.create_engine(DATABASE_URL)


@pytest.fixture(scope="module", autouse=True)
def _ensure_table():
    import sqlalchemy
    eng = _sync_engine()
    with eng.begin() as conn:
        conn.execute(sqlalchemy.text(_DDL))
    eng.dispose()
    yield
    # Clean only our test rows; leave the table for the real migration.
    eng = _sync_engine()
    with eng.begin() as conn:
        conn.execute(
            sqlalchemy.text("DELETE FROM subject_review_bundles WHERE run_id LIKE :p"),
            {"p": RUN_PREFIX + "%"},
        )
    eng.dispose()


def _row(token):
    import sqlalchemy
    eng = _sync_engine()
    with eng.connect() as conn:
        r = conn.execute(
            sqlalchemy.text("SELECT * FROM subject_review_bundles WHERE token = :t"),
            {"t": token},
        ).mappings().first()
    eng.dispose()
    return r


def _async_url(url):
    return url.replace("postgresql://", "postgresql+asyncpg://", 1) if url.startswith("postgresql://") else url


async def _override_session():
    """Fresh NullPool engine per request, bound to the current (TestClient portal)
    event loop. The app's module-global async engine pins its asyncpg pool to the
    first loop it sees, which a later TestClient's loop then can't reuse ('another
    operation is in progress'); a per-request engine sidesteps that entirely."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(
        _async_url(DATABASE_URL), poolclass=NullPool, connect_args={"ssl": False}
    )
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with maker() as session:
            yield session
    finally:
        await engine.dispose()


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lct_python_backend.db_session import get_async_session
    from lct_python_backend.subject_review_api import router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_async_session] = _override_session
    return TestClient(app)


def _bundle_body(**kw):
    base = dict(
        contract_version="1",
        prayer_id=4242,
        run_id=RUN_PREFIX + uuid.uuid4().hex[:10],
        callback_token="cbk-" + uuid.uuid4().hex,
        subject_email="subject@example.com",
        subject_name="Subject Person",
        items=[
            {"position_in_doc": 7, "original_text": "my own words here", "proposed_redaction": "my [REDACTED] here"},
            {"position_in_doc": 9, "original_text": "another own line", "proposed_redaction": "another [X]"},
        ],
    )
    base.update(kw)
    return base


def _import(client, **kw):
    body = _bundle_body(**kw)
    resp = client.post("/api/subject-review/import", json=body)
    return resp, body


def _token_from_url(review_url):
    return review_url.rstrip("/").rsplit("/", 1)[-1]


def _patch_google(monkeypatch, email):
    import lct_python_backend.subject_review_api as api

    async def _fake_verify(_token):
        return email.strip().lower()

    monkeypatch.setattr(api, "_verify_google_id_token", _fake_verify)
    monkeypatch.setattr(api, "GOOGLE_OAUTH_CLIENT_ID", "test-client-id")


def _patch_relay(monkeypatch, outcome=("relayed", {"prayer_substate": "AWAITING_OWNER_APPROVAL", "additions_applied": 1}), calls=None):
    import lct_python_backend.subject_review_api as api

    async def _fake_relay(prayer_id, callback_token, decisions):
        if calls is not None:
            calls.append({"prayer_id": prayer_id, "callback_token": callback_token, "decisions": decisions})
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(api, "_relay_to_indrasnet", _fake_relay)


_AUTH = {"Authorization": "Bearer fake-google-id-token"}


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------


def test_import_happy_path_stores_and_returns_url_not_token():
    client = _client()
    resp, body = _import(client)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "review_url" in data
    token = _token_from_url(data["review_url"])
    # the response must NOT carry the callback token or prayer_id
    assert body["callback_token"] not in resp.text
    assert "prayer_id" not in data
    row = _row(token)
    assert row["status"] == "pending"
    assert row["callback_token"] == body["callback_token"]  # stored server-side
    assert row["subject_email"] == "subject@example.com"
    items = json.loads(row["items_json"])
    assert {it["position_in_doc"] for it in items} == {7, 9}


def test_import_rejects_extra_field_422():
    client = _client()
    body = _bundle_body()
    body["reason"] = "model generated owner text"
    resp = client.post("/api/subject-review/import", json=body)
    assert resp.status_code == 422, resp.text


def test_import_422_does_not_echo_callback_token_or_content():
    """codex finding #2: a sanitized 422 must NOT echo the rejected input —
    otherwise the callback_token (and item text) land in the response body and,
    via IndrasNet's response-logging client, in IndrasNet's logs."""
    client = _client()
    body = _bundle_body()
    # over-long callback_token (>4000) carrying a sentinel -> validation fails
    body["callback_token"] = "SENTINELTOK-" + ("z" * 5000)
    body["items"][0]["original_text"] = "SENTINELCONTENT-secret-own-words"
    body["contract_version"] = "9"  # also wrong, to force a second error
    resp = client.post("/api/subject-review/import", json=body)
    assert resp.status_code == 422, resp.text
    assert "SENTINELTOK" not in resp.text
    assert "SENTINELCONTENT" not in resp.text
    # the sanitized body still names the failing fields (loc) + type
    data = resp.json()
    assert data["detail"] == "Invalid subject-review bundle."
    locs = [tuple(e["loc"]) for e in data["errors"]]
    assert any("callback_token" in loc for loc in locs)


def test_get_no_bearer_does_not_reveal_nonexistent_vs_revoked(monkeypatch):
    """codex finding #3: without a bearer, the GET returns 401 for ANY token —
    nonexistent, revoked, or live — so a token-holder gets no existence/lifecycle
    oracle. (No Google patch needed: the gate returns before the DB lookup.)"""
    import sqlalchemy
    client = _client()
    # GOOGLE must be configured for a 401 (else 503); patch the module global.
    monkeypatch.setattr("lct_python_backend.subject_review_api.GOOGLE_OAUTH_CLIENT_ID", "test-client-id")

    # nonexistent token -> 401 (not 404)
    assert client.get("/api/subject-review/does-not-exist-zzz").status_code == 401

    # revoked token, no bearer -> 401 (not 410)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    eng = _sync_engine()
    with eng.begin() as conn:
        conn.execute(sqlalchemy.text(
            "UPDATE subject_review_bundles SET revoked_at = now() WHERE token = :t"), {"t": token})
    eng.dispose()
    assert client.get(f"/api/subject-review/{token}").status_code == 401


def test_import_422_does_not_echo_smuggled_key():
    """codex round-2 #2: a secret smuggled as a JSON KEY lands in Pydantic's
    extra_forbidden `loc`; the sanitized 422 must replace it with <extra>."""
    client = _client()
    body = _bundle_body()
    body["SENTINELKEY-secret-as-json-key"] = "x"          # extra top-level key
    body["items"][0]["SENTINELITEMKEY-secret-words"] = "y"  # extra item-level key
    resp = client.post("/api/subject-review/import", json=body)
    assert resp.status_code == 422, resp.text
    assert "SENTINELKEY" not in resp.text
    assert "SENTINELITEMKEY" not in resp.text
    assert "<extra>" in resp.text  # smuggled keys masked


def test_import_oversized_prayer_id_422_no_token_echo():
    """codex round-3: an oversized prayer_id must be rejected at validation (422),
    NOT reach the INSERT where the DB error would embed the callback_token +
    item text in the (loggable) exception."""
    client = _client()
    body = _bundle_body(prayer_id=9_999_999_999)  # > Postgres int4 max
    body["callback_token"] = "SENTINELTOK3-" + ("a" * 20)
    resp = client.post("/api/subject-review/import", json=body)
    assert resp.status_code == 422, resp.text
    assert "SENTINELTOK3" not in resp.text
    locs = [tuple(e["loc"]) for e in resp.json()["errors"]]
    assert any("prayer_id" in loc for loc in locs)


def test_sanitize_db_errors_decorator_hides_params():
    """grok round-4 (C): a SQLAlchemyError (whose string embeds bound params like
    the token/decisions) must become a sanitized 503 — no SQL/params echoed."""
    import asyncio
    from fastapi import HTTPException
    from sqlalchemy.exc import OperationalError
    import lct_python_backend.subject_review_api as api

    @api._sanitize_db_errors
    async def boom():
        raise OperationalError(
            "UPDATE subject_review_bundles ... WHERE token = 'SENTINEL_DB_TOKEN'",
            {"decisions_json": "SENTINEL_DB_CONTENT"},
            Exception("orig"),
        )

    with pytest.raises(HTTPException) as ei:
        asyncio.run(boom())
    assert ei.value.status_code == 503
    assert "SENTINEL_DB_TOKEN" not in str(ei.value.detail)
    assert "SENTINEL_DB_CONTENT" not in str(ei.value.detail)


def _patch_google_invalid(monkeypatch):
    import lct_python_backend.subject_review_api as api
    from fastapi import HTTPException

    async def _raise(_token):
        raise HTTPException(status_code=401, detail="Invalid Google ID token.")

    monkeypatch.setattr(api, "_verify_google_id_token", _raise)
    monkeypatch.setattr(api, "GOOGLE_OAUTH_CLIENT_ID", "test-client-id")


def test_get_invalid_bearer_no_existence_oracle(monkeypatch):
    """codex round-2 #3: a present-but-INVALID bearer must 401 BEFORE the DB
    lookup, identically for existing and nonexistent tokens (no 404 oracle)."""
    client = _client()
    token = _token_from_url(_import(client)[0].json()["review_url"])  # create before patching
    _patch_google_invalid(monkeypatch)
    r_exist = client.get(f"/api/subject-review/{token}", headers=_AUTH)
    r_missing = client.get("/api/subject-review/does-not-exist-zzz", headers=_AUTH)
    assert r_exist.status_code == 401
    assert r_missing.status_code == 401  # same response — no existence oracle


def test_decisions_invalid_bearer_no_existence_oracle(monkeypatch):
    client = _client()
    token = _token_from_url(_import(client)[0].json()["review_url"])
    _patch_google_invalid(monkeypatch)
    r_exist = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    r_missing = client.post("/api/subject-review/does-not-exist-zzz/decisions", headers=_AUTH, json=_good_decisions())
    assert r_exist.status_code == 401
    assert r_missing.status_code == 401


# --------------------------------------------------------------------------
# GET — Google gate + token-never-served canary
# --------------------------------------------------------------------------


def test_get_requires_google_when_no_bearer(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    token = _token_from_url(_import(client)[0].json()["review_url"])
    resp = client.get(f"/api/subject-review/{token}")
    assert resp.status_code == 401
    assert resp.json().get("auth_required") == "google"


def test_get_returns_items_and_never_the_token(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    resp_i, body = _import(client)
    token = _token_from_url(resp_i.json()["review_url"])
    resp = client.get(f"/api/subject-review/{token}", headers=_AUTH)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert set(data.keys()) == {"subject_name", "items", "status", "viewer_email"}
    assert data["viewer_email"] == "subject@example.com"
    assert {it["position_in_doc"] for it in data["items"]} == {7, 9}
    # canary: the callback token / prayer_id are structurally absent
    assert body["callback_token"] not in resp.text
    assert "callback_token" not in resp.text
    assert str(body["prayer_id"]) not in resp.text


def test_get_wrong_email_403(monkeypatch):
    client = _client()
    token = _token_from_url(_import(client)[0].json()["review_url"])
    _patch_google(monkeypatch, "attacker@example.com")
    resp = client.get(f"/api/subject-review/{token}", headers=_AUTH)
    assert resp.status_code == 403


def test_get_revoked_410(monkeypatch):
    import sqlalchemy
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    token = _token_from_url(_import(client)[0].json()["review_url"])
    eng = _sync_engine()
    with eng.begin() as conn:
        conn.execute(sqlalchemy.text(
            "UPDATE subject_review_bundles SET revoked_at = now() WHERE token = :t"), {"t": token})
    eng.dispose()
    resp = client.get(f"/api/subject-review/{token}", headers=_AUTH)
    assert resp.status_code == 410


# --------------------------------------------------------------------------
# decisions — validation
# --------------------------------------------------------------------------


def test_decisions_missing_position_422(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    _patch_relay(monkeypatch)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    resp = client.post(
        f"/api/subject-review/{token}/decisions",
        headers=_AUTH,
        json={"decisions": [{"position_in_doc": 7, "action": "confirm"}]},  # missing 9
    )
    assert resp.status_code == 422, resp.text


def test_decisions_redact_span_non_substring_422(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    _patch_relay(monkeypatch)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    resp = client.post(
        f"/api/subject-review/{token}/decisions",
        headers=_AUTH,
        json={"decisions": [
            {"position_in_doc": 7, "action": "redact_more", "redact_span": "NOT PRESENT"},
            {"position_in_doc": 9, "action": "confirm"},
        ]},
    )
    assert resp.status_code == 422, resp.text


# --------------------------------------------------------------------------
# decisions — state machine
# --------------------------------------------------------------------------


def _good_decisions():
    return {"decisions": [
        {"position_in_doc": 7, "action": "confirm"},
        {"position_in_doc": 9, "action": "redact_more", "redact_span": "[X]"},
    ]}


def test_decisions_happy_path_relays_and_scrubs(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    calls = []
    _patch_relay(monkeypatch, calls=calls)
    resp_i, body = _import(client)
    token = _token_from_url(resp_i.json()["review_url"])
    resp = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "relayed"
    assert resp.json()["result"]["prayer_substate"] == "AWAITING_OWNER_APPROVAL"
    # relay received the callback token + minimal decisions
    assert len(calls) == 1
    assert calls[0]["callback_token"] == body["callback_token"]
    # post-relay scrub: token + own-words NULLed, status relayed, hash set
    row = _row(token)
    assert row["status"] == "relayed"
    assert row["callback_token"] is None
    assert row["items_json"] is None
    assert row["decision_hash"]
    assert row["relayed_at"] is not None


def test_decisions_idempotent_same_hash_no_second_relay(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    calls = []
    _patch_relay(monkeypatch, calls=calls)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    r1 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r1.status_code == 200
    r2 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r2.status_code == 200
    assert r2.json()["status"] == "relayed"
    # relay called exactly once (the second hit returns the stored terminal result)
    assert len(calls) == 1


def test_decisions_different_hash_after_submit_409(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    _patch_relay(monkeypatch)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    r1 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r1.status_code == 200
    # a DIFFERENT valid decision set must be refused, even though it's well-formed
    different = {"decisions": [
        {"position_in_doc": 7, "action": "reject"},
        {"position_in_doc": 9, "action": "confirm"},
    ]}
    r2 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=different)
    assert r2.status_code == 409, r2.text


def test_decisions_relay_failure_502_then_retry_succeeds(monkeypatch):
    import lct_python_backend.subject_review_api as api
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    token = _token_from_url(_import(client)[0].json()["review_url"])

    # first attempt: relay raises -> 502, decisions persisted, status failed
    _patch_relay(monkeypatch, outcome=api.RelayFailed("could not reach the review service"))
    r1 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r1.status_code == 502, r1.text
    row = _row(token)
    assert row["status"] == "failed"
    assert row["decision_hash"]            # decisions were persisted before relay
    assert row["callback_token"] is not None  # not scrubbed on failure (retry needs it)
    assert "could not reach" in (row["last_error"] or "")

    # retry SAME decisions: relay succeeds -> 200 relayed
    _patch_relay(monkeypatch)
    r2 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "relayed"
    row = _row(token)
    assert row["status"] == "relayed"
    assert row["callback_token"] is None


def test_decisions_relayed_then_different_hash_still_409(monkeypatch):
    client = _client()
    _patch_google(monkeypatch, "subject@example.com")
    _patch_relay(monkeypatch)
    token = _token_from_url(_import(client)[0].json()["review_url"])
    r1 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert r1.status_code == 200
    # post-relay POST of a DIFFERENT set must never get a false success.
    different = {"decisions": [
        {"position_in_doc": 7, "action": "reject"},
        {"position_in_doc": 9, "action": "confirm"},
    ]}
    r2 = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=different)
    assert r2.status_code == 409, r2.text


def test_decisions_wrong_email_403(monkeypatch):
    client = _client()
    token = _token_from_url(_import(client)[0].json()["review_url"])
    _patch_google(monkeypatch, "attacker@example.com")
    _patch_relay(monkeypatch)
    resp = client.post(f"/api/subject-review/{token}/decisions", headers=_AUTH, json=_good_decisions())
    assert resp.status_code == 403
