"""HTTP contract tests for the IndraSNet audio bridge.

Test intent: see tests/intent/indrasnet-audio-library.md.
Only content-free fixtures are used; no sibling service or database is contacted.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from lct_python_backend import auth_policy, indrasnet_audio_api as audio_api


class _FakeSession:
    def __init__(self, existing=None, has_graph=True):
        self.results = [existing, "graph-node" if has_graph else None]

    async def execute(self, query):
        return SimpleNamespace(scalar_one_or_none=lambda: self.results.pop(0))

    async def rollback(self):
        return None


def _client(*, bypass_auth=True, existing=None, has_graph=True):
    app = FastAPI()
    app.include_router(audio_api.router)
    if bypass_auth:
        app.dependency_overrides[audio_api.require_source_auth] = lambda: None

    async def fake_db():
        yield _FakeSession(existing, has_graph)

    app.dependency_overrides[audio_api.get_async_session] = fake_db
    return TestClient(app)


def test_catalog_requires_owner_bearer_even_without_global_middleware(monkeypatch):
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", "synthetic-owner-token")
    monkeypatch.setattr(auth_policy, "ADMIN_AUTH_TOKEN", None)

    async def sibling(method, path, **kwargs):
        return {"sources": [], "has_more": False}

    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    client = _client(bypass_auth=False)
    assert client.get("/api/indrasnet/audio-sources").status_code == 401
    assert client.get("/api/indrasnet/audio-sources",
                      headers={"Authorization": "Bearer synthetic-owner-token"}).status_code == 200


def test_catalog_exposes_metadata_only(monkeypatch):
    async def sibling(method, path, **kwargs):
        assert method == "GET"
        assert path == "/api/lct/audio-sources"
        assert kwargs["params"] == {"q": "planning", "limit": 30, "offset": 0}
        return {
            "sources": [{
                "source_key": "media:7", "source_kind": "media",
                "title": "Planning call", "recorded_at": None,
                "duration_seconds": 60, "status": "ready",
                "can_process": False, "transcript": "must not leave server",
            }],
            "has_more": False,
        }

    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    response = _client().get("/api/indrasnet/audio-sources?q=planning")
    assert response.status_code == 200
    body = response.json()
    assert body["sources"][0]["source_key"] == "media:7"
    assert "transcript" not in body["sources"][0]


def test_process_and_status_use_typed_key(monkeypatch):
    calls = []

    async def sibling(method, path, **kwargs):
        calls.append((method, path))
        return {"source_key": "item:9", "status": "queued", "stage": "Waiting for transcription",
                "job_id": 12, "can_process": False}

    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    client = _client()
    started = client.post("/api/indrasnet/audio-sources/item:9/process")
    status = client.get("/api/indrasnet/audio-sources/item:9/status")
    assert started.status_code == status.status_code == 200
    assert started.json()["status"] == status.json()["status"] == "queued"
    assert calls == [
        ("POST", "/api/lct/audio-sources/item:9/process"),
        ("GET", "/api/lct/audio-sources/item:9/status"),
    ]


def test_bad_key_rejected_before_sibling_call(monkeypatch):
    sibling = AsyncMock()
    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    response = _client().post("/api/indrasnet/audio-sources/media:0/import")
    assert response.status_code == 400
    sibling.assert_not_called()


def test_ready_source_imports_existing_turn_contract(monkeypatch):
    raw = {
        "contract_version": "1", "group_id": "indrasnet_audio:media:7",
        "conversation_name": "Fixture conversation", "source_type": "indrasnet_audio",
        "owner_id": "upstream-owner",
        "privacy": {"redaction_applied": True, "external_llm_ok": False},
        "turns": [{"seq": 0, "source_identifier": "media:7:0",
                   "speaker_id": "UNKNOWN", "text": "Example sentence."}],
    }

    async def sibling(method, path, **kwargs):
        assert (method, path) == ("GET", "/api/lct/audio-sources/media:7/turns")
        return raw

    persisted = AsyncMock(return_value={
        "conversation_id": "00000000-0000-0000-0000-000000000007",
        "utterance_count": 1, "participant_count": 1,
    })
    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    monkeypatch.setattr(audio_api, "persist_turns", persisted)
    monkeypatch.setattr(audio_api, "get_current_owner_id", lambda: "local-owner")
    response = _client().post("/api/indrasnet/audio-sources/media:7/import")
    assert response.status_code == 200
    assert response.json()["conversation_id"].endswith("0007")
    assert persisted.await_args.kwargs["payload"].owner_id == "local-owner"
    assert persisted.await_args.kwargs["payload"].conversation_id is None
    assert persisted.await_args.kwargs["payload"].turns[0].source_identifier == "media:7:0"


def test_repeat_import_opens_existing_without_replacing_graph_or_turns(monkeypatch):
    existing = SimpleNamespace(id="existing-conversation", total_utterances=5, total_nodes=3)

    async def sibling(method, path, **kwargs):
        return {
            "contract_version": "1", "group_id": "indrasnet_audio:media:7",
            "conversation_name": "Fixture", "source_type": "indrasnet_audio",
            "owner_id": "sibling-owner", "privacy": {"redaction_applied": True},
            "turns": [{"seq": 0, "source_identifier": "media:7:0",
                       "speaker_id": "UNKNOWN", "text": "Synthetic line"}],
        }

    persisted = AsyncMock()
    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    monkeypatch.setattr(audio_api, "persist_turns", persisted)
    monkeypatch.setattr(audio_api, "get_current_owner_id", lambda: "local-owner")
    response = _client(existing=existing).post("/api/indrasnet/audio-sources/media:7/import")
    assert response.status_code == 200
    assert response.json()["conversation_id"] == "existing-conversation"
    assert response.json()["already_imported"] is True
    assert response.json()["needs_extraction"] is False
    pending_graph = _client(existing=existing, has_graph=False).post(
        "/api/indrasnet/audio-sources/media:7/import")
    assert pending_graph.status_code == 200
    assert pending_graph.json()["needs_extraction"] is True
    persisted.assert_not_called()


def test_mismatched_group_rejected_before_lookup_or_persistence(monkeypatch):
    async def sibling(method, path, **kwargs):
        return {
            "contract_version": "1", "group_id": "indrasnet_audio:media:8",
            "conversation_name": "Wrong recording", "source_type": "indrasnet_audio",
            "owner_id": "sibling-owner", "privacy": {"redaction_applied": True},
            "turns": [{"seq": 0, "source_identifier": "media:8:0",
                       "speaker_id": "UNKNOWN", "text": "Wrong line"}],
        }

    persisted = AsyncMock()
    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    monkeypatch.setattr(audio_api, "persist_turns", persisted)
    response = _client().post("/api/indrasnet/audio-sources/media:7/import")
    assert response.status_code == 502
    assert "different recording" in response.json()["detail"]
    persisted.assert_not_called()


def test_private_retention_policy_failure_is_clear(monkeypatch):
    async def sibling(method, path, **kwargs):
        return {
            "contract_version": "1", "group_id": "indrasnet_audio:media:7",
            "conversation_name": "Fixture", "source_type": "indrasnet_audio",
            "owner_id": "sibling-owner", "privacy": {"redaction_applied": False},
            "owner_local_raw": True,
            "turns": [{"seq": 0, "source_identifier": "media:7:0",
                       "speaker_id": "UNKNOWN", "text": "Synthetic line"}],
        }

    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    monkeypatch.setattr(audio_api, "persist_turns", AsyncMock(
        side_effect=audio_api.DeploymentPrivacyError("restricted deployment")))
    response = _client().post("/api/indrasnet/audio-sources/media:7/import")
    assert response.status_code == 409
    assert "cannot retain" in response.json()["detail"]
    assert "Synthetic line" not in response.text


def test_pending_source_does_not_import(monkeypatch):
    async def sibling(method, path, **kwargs):
        raise HTTPException(status_code=409, detail="Audio transcript is not ready.")

    persisted = AsyncMock()
    monkeypatch.setattr(audio_api, "_indrasnet_json", sibling)
    monkeypatch.setattr(audio_api, "persist_turns", persisted)
    response = _client().post("/api/indrasnet/audio-sources/media:7/import")
    assert response.status_code == 409
    persisted.assert_not_called()


def test_disabled_indrasnet_is_visible_as_unavailable(monkeypatch):
    def disabled():
        raise audio_api.IndrasNetDisabled("disabled")

    monkeypatch.setattr(audio_api, "get_indrasnet_base_url", disabled)
    response = _client().get("/api/indrasnet/audio-sources")
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]

def test_sibling_missing_list_and_processing_conflict_have_contextual_errors(monkeypatch):
    monkeypatch.setattr(audio_api, "get_indrasnet_base_url", lambda: "http://synthetic.local")
    status = [404]

    class StubClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def request(self, method, url, params=None):
            return SimpleNamespace(status_code=status[0])

    monkeypatch.setattr(audio_api.httpx, "AsyncClient", lambda **kwargs: StubClient())
    with pytest.raises(HTTPException) as missing:
        asyncio.run(audio_api._indrasnet_json("GET", "/api/lct/audio-sources"))
    assert missing.value.status_code == 503
    assert "not available" in missing.value.detail
    status[0] = 409
    with pytest.raises(HTTPException) as conflict:
        asyncio.run(audio_api._indrasnet_json("POST", "/api/lct/audio-sources/media:7/process"))
    assert conflict.value.status_code == 409
    assert "file and transcription configuration" in conflict.value.detail
