"""Route-level tests for lct_python_backend.conversations_api.

These tests use FastAPI TestClient + dependency_overrides to exercise
the HTTP contract without a real database or external services.

Covers:
- GET  /conversations/{id}: ownership gate (ADR-034) — non-owner → 404 not 403;
  not-found → 404; invalid UUID → 500 (caught by broad except).
- DELETE /conversations/{id}: not found → 404; soft-delete returns message.
- PATCH /conversations/{id}/graph: invalid UUID → 422; empty nodes → 200.
- POST  /api/conversations/{id}/draft: extra field → 422 (ADR-030 whitelist);
  empty body → 200 with empty lists; conversation_name → persisted list;
  other allowed keys → deferred list.
- GET   /api/conversations/{id}/utterances: returns {utterances, total}.
"""

import importlib
import sys
import types
import uuid
from contextlib import asynccontextmanager
from typing import Any, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Minimal Pydantic stubs for FastAPI response_model types at import time
# ---------------------------------------------------------------------------

class _StubSaveJsonResponseExtended(BaseModel):
    file_id: str = ""
    file_name: str = ""
    message: str = ""
    no_of_nodes: int = 0
    created_at: Optional[str] = None
    conversation_type: Optional[str] = None
    duration_seconds: Optional[int] = None
    started_at: Optional[str] = None
    total_utterances: int = 0
    participants: list = []


class _StubConversationResponse(BaseModel):
    graph_data: list = []
    chunk_dict: dict = {}
    conversation_title: Optional[str] = None
    executive_summary: Optional[str] = None


# ---------------------------------------------------------------------------
# Module loader — same stub pattern as test_conversations_api.py
# ---------------------------------------------------------------------------

def _stub_modules(monkeypatch):
    async def _dummy_session():
        yield object()

    dummy_db = types.ModuleType("lct_python_backend.db_session")
    dummy_db.get_async_session = _dummy_session
    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db)

    for mod_path in [
        "lct_python_backend.services.conversation_reader",
        "lct_python_backend.services.gcs_helpers",
        "lct_python_backend.services.owner_context",
        "lct_python_backend.services.turn_synthesizer",
    ]:
        stub = types.ModuleType(mod_path)
        stub.build_chunk_dict_from_utterances = MagicMock(return_value={})
        stub.build_graph_data_from_nodes = MagicMock(return_value=[])
        stub.build_relationship_maps = MagicMock(return_value={})
        stub.fetch_conversation_bundle = AsyncMock(return_value=(None, [], [], []))
        stub.serialize_utterances = MagicMock(return_value=[])
        stub.wrap_graph_data_chunks = MagicMock(return_value=[])
        stub.LOCAL_SAVE_DIR = MagicMock()
        stub.load_conversation_from_gcs = MagicMock(return_value={})
        stub.get_current_owner_id = MagicMock(return_value="owner-123")
        stub.build_turn_graph_from_utterances = MagicMock(return_value=[])
        monkeypatch.setitem(sys.modules, mod_path, stub)

    # graph_persistence is lazy-imported inside patch_conversation_graph at call time
    dummy_gp = types.ModuleType("lct_python_backend.services.graph_persistence")
    dummy_gp.persist_graph = AsyncMock(return_value=3)
    monkeypatch.setitem(sys.modules, "lct_python_backend.services.graph_persistence", dummy_gp)

    # owner_context needs resolve_owner_id for graph_persistence's own import chain
    owner_stub = sys.modules.get("lct_python_backend.services.owner_context")
    if owner_stub:
        owner_stub.resolve_owner_id = MagicMock(return_value="owner-123")

    dummy_cfg = types.ModuleType("lct_python_backend.config")
    dummy_cfg.GCS_BUCKET_NAME = "test-bucket"
    monkeypatch.setitem(sys.modules, "lct_python_backend.config", dummy_cfg)

    dummy_schemas = types.ModuleType("lct_python_backend.schemas")
    dummy_schemas.ConversationResponse = _StubConversationResponse
    dummy_schemas.SaveJsonResponseExtended = _StubSaveJsonResponseExtended
    monkeypatch.setitem(sys.modules, "lct_python_backend.schemas", dummy_schemas)

    sys.modules.pop("lct_python_backend.conversations_api", None)


def _load(monkeypatch):
    _stub_modules(monkeypatch)
    return importlib.import_module("lct_python_backend.conversations_api")


def _build_client(module, session_override=None):
    """Build TestClient with an optional DB session override."""
    if session_override is None:
        async def _noop_session():
            yield _FakeSession()
        session_override = _noop_session

    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[module.get_async_session] = session_override
    return TestClient(app)


# ---------------------------------------------------------------------------
# Minimal fake DB session helpers
# ---------------------------------------------------------------------------

class _FakeScalars:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _FakeResult:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def scalars(self):
        return _FakeScalars(self._rows)

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _FakeSession:
    def __init__(self, rows=()):
        self._rows = list(rows)
        self.committed = False
        self.deleted = None

    async def execute(self, *args, **kwargs):
        return _FakeResult(self._rows)

    async def commit(self):
        self.committed = True

    async def delete(self, obj):
        self.deleted = obj


def _session_with(rows=(), fake=None):
    """Return a dependency override that yields a FakeSession."""
    if fake is None:
        fake = _FakeSession(rows)

    async def _override():
        yield fake

    return _override


# ---------------------------------------------------------------------------
# GET /conversations/{conversation_id} — ownership gate (ADR-034)
# ---------------------------------------------------------------------------

class TestGetConversation:
    def test_not_found_returns_404(self, monkeypatch):
        module = _load(monkeypatch)
        # fetch_conversation_bundle returns None conversation → 404
        module.fetch_conversation_bundle = AsyncMock(return_value=(None, [], [], []))
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.get(f"/conversations/{cid}")
        assert resp.status_code == 404

    def test_ownership_mismatch_returns_404_not_403(self, monkeypatch):
        """ADR-034: non-owner must get 404, not 403, to prevent id enumeration."""
        module = _load(monkeypatch)
        conv = MagicMock()
        conv.owner_id = "other-owner"
        conv.source_metadata = {}
        conv.conversation_name = "Test"
        module.fetch_conversation_bundle = AsyncMock(return_value=(conv, [], [], []))
        module.get_current_owner_id = MagicMock(return_value="my-owner")
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.get(f"/conversations/{cid}")
        assert resp.status_code == 404
        # Must not say "403 Forbidden" or reveal it's an auth issue
        body = resp.json()
        assert "403" not in str(body)
        assert "forbidden" not in str(body).lower()

    def test_owner_match_returns_200(self, monkeypatch):
        module = _load(monkeypatch)
        conv = MagicMock()
        conv.owner_id = "owner-123"
        conv.source_metadata = {"conversation_title": "Meeting", "executive_summary": "We talked."}
        conv.conversation_name = "Meeting"
        module.fetch_conversation_bundle = AsyncMock(return_value=(conv, [], [], []))
        module.get_current_owner_id = MagicMock(return_value="owner-123")
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.get(f"/conversations/{cid}")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# DELETE /conversations/{conversation_id}
# ---------------------------------------------------------------------------

class TestDeleteConversation:
    def test_not_found_returns_404(self, monkeypatch):
        module = _load(monkeypatch)
        # FakeSession with no rows → scalar_one_or_none → None → 404
        client = _build_client(module, _session_with([]))
        cid = str(uuid.uuid4())
        resp = client.delete(f"/conversations/{cid}")
        assert resp.status_code == 404

    def test_soft_delete_returns_deleted_message(self, monkeypatch):
        module = _load(monkeypatch)
        conv = MagicMock()
        conv.gcs_path = None
        client = _build_client(module, _session_with([conv]))
        cid = str(uuid.uuid4())
        resp = client.delete(f"/conversations/{cid}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["message"] == "Conversation deleted"
        assert body["conversation_id"] == cid

    def test_hard_delete_returns_permanently_deleted_message(self, monkeypatch):
        module = _load(monkeypatch)
        conv = MagicMock()
        conv.gcs_path = None
        client = _build_client(module, _session_with([conv]))
        cid = str(uuid.uuid4())
        resp = client.delete(f"/conversations/{cid}?hard_delete=true")
        assert resp.status_code == 200
        body = resp.json()
        assert "permanently" in body["message"]


# ---------------------------------------------------------------------------
# PATCH /conversations/{conversation_id}/graph
# ---------------------------------------------------------------------------

class TestPatchConversationGraph:
    def test_invalid_uuid_returns_422(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        resp = client.patch(
            "/conversations/not-a-uuid/graph",
            json={"nodes": [{"id": "n1"}]},
        )
        assert resp.status_code == 422

    def test_empty_nodes_returns_persisted_zero(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.patch(
            f"/conversations/{cid}/graph",
            json={"nodes": []},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["persisted"] == 0
        assert body["conversation_id"] == cid


# ---------------------------------------------------------------------------
# POST /api/conversations/{conversation_id}/draft  (ADR-030 §D6 whitelist)
# ---------------------------------------------------------------------------

class TestSaveConversationDraft:
    def test_unknown_field_rejected_422(self, monkeypatch):
        """ADR-030: semantic state must not pass through the draft endpoint."""
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(
            f"/api/conversations/{cid}/draft",
            json={"nodes": [{"id": "n1", "is_crux": True}]},
        )
        assert resp.status_code == 422

    def test_forbidden_semantic_fields_rejected(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        for field in ("relationships", "claims", "utterances", "is_tangent",
                      "transcript_events", "speaker_segments"):
            resp = client.post(
                f"/api/conversations/{cid}/draft",
                json={field: "smuggled"},
            )
            assert resp.status_code == 422, f"{field} should be rejected"

    def test_empty_body_returns_empty_lists(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(f"/api/conversations/{cid}/draft", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["persisted"] == []
        assert body["deferred"] == []

    def test_conversation_name_appears_in_persisted(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(
            f"/api/conversations/{cid}/draft",
            json={"conversation_name": "New Name"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "conversation_name" in body["persisted"]
        assert "conversation_name" not in body["deferred"]

    def test_viewport_appears_in_deferred(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(
            f"/api/conversations/{cid}/draft",
            json={"viewport": {"zoom": 1.5, "x": 0, "y": 0}},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "viewport" in body["deferred"]
        assert "viewport" not in body["persisted"]

    def test_all_allowed_keys_accepted(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(
            f"/api/conversations/{cid}/draft",
            json={
                "conversation_name": "Test",
                "viewport": {"zoom": 1},
                "canvas_overrides": {"n1": {"x": 0, "y": 0}},
                "dismissed_unlock_affordances": ["level2"],
                "active_tab": "graph",
                "active_color_mode": "speaker",
                "show_temporal_edges": True,
                "local_draft_text": "WIP notes",
                "pinned_node_ids": ["n1"],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "conversation_name" in body["persisted"]
        assert len(body["deferred"]) == 8  # all other allowed keys

    def test_invalid_uuid_returns_422(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        resp = client.post(
            "/api/conversations/not-a-uuid/draft",
            json={"conversation_name": "Test"},
        )
        assert resp.status_code == 422

    def test_whitespace_only_name_not_persisted(self, monkeypatch):
        module = _load(monkeypatch)
        client = _build_client(module)
        cid = str(uuid.uuid4())
        resp = client.post(
            f"/api/conversations/{cid}/draft",
            json={"conversation_name": "   "},
        )
        assert resp.status_code == 200
        body = resp.json()
        # Whitespace-only name is stripped → empty → not persisted
        assert "conversation_name" not in body["persisted"]


# ---------------------------------------------------------------------------
# GET /api/conversations/{conversation_id}/utterances
# ---------------------------------------------------------------------------

class TestGetConversationUtterances:
    def test_returns_utterances_and_total(self, monkeypatch):
        module = _load(monkeypatch)
        # serialize_utterances returns a list; we stub it
        module.serialize_utterances = MagicMock(return_value=[
            {"id": "u1", "text": "Hello"},
            {"id": "u2", "text": "World"},
        ])
        client = _build_client(module, _session_with([]))
        cid = str(uuid.uuid4())
        resp = client.get(f"/api/conversations/{cid}/utterances")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert len(body["utterances"]) == 2

    def test_empty_conversation_returns_zero_total(self, monkeypatch):
        module = _load(monkeypatch)
        module.serialize_utterances = MagicMock(return_value=[])
        client = _build_client(module, _session_with([]))
        cid = str(uuid.uuid4())
        resp = client.get(f"/api/conversations/{cid}/utterances")
        assert resp.status_code == 200
        assert resp.json()["total"] == 0
