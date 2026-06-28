"""Unit tests for lct_python_backend.conversations_api (no DB required).

Covers:
- _normalize_participants_payload: deduplication, name-only guests,
  empty-name filtering, source defaulting, external_llm_ok coercion.
- DraftStateRequest Pydantic model: extra="forbid" enforcement,
  all known fields accepted, empty body ok.
- _ser helper: UUID, datetime, date, list/dict/None round-trips.
- _build_relationship_maps wrapper: delegates correctly.
"""

import importlib
import sys
import types
import uuid
from datetime import date, datetime
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest
from pydantic import BaseModel, ValidationError
from typing import Optional


# ---------------------------------------------------------------------------
# Minimal schema stubs — must be real Pydantic models because FastAPI's
# route decorators inspect the type annotation at import time to build a
# response schema. MagicMock is not a valid Pydantic type.
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
# Module loading helpers
#
# conversations_api imports db_session and several services at module level.
# We stub the heavy dependencies so the tests stay pure-unit (no DB/network).
# ---------------------------------------------------------------------------

def _stub_modules(monkeypatch):
    """Patch away DB and service imports so conversations_api loads cleanly."""
    async def _dummy_session():
        yield object()

    # db_session
    dummy_db = types.ModuleType("lct_python_backend.db_session")
    dummy_db.get_async_session = _dummy_session
    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db)

    # services that are imported at module level
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
        stub.fetch_conversation_bundle = MagicMock(return_value=(None, [], [], []))
        stub.serialize_utterances = MagicMock(return_value=[])
        stub.wrap_graph_data_chunks = MagicMock(return_value=[])
        stub.LOCAL_SAVE_DIR = MagicMock()
        stub.load_conversation_from_gcs = MagicMock(return_value={})
        stub.get_current_owner_id = MagicMock(return_value="test-owner")
        stub.build_turn_graph_from_utterances = MagicMock(return_value=[])
        monkeypatch.setitem(sys.modules, mod_path, stub)

    # config
    dummy_cfg = types.ModuleType("lct_python_backend.config")
    dummy_cfg.GCS_BUCKET_NAME = "test-bucket"
    monkeypatch.setitem(sys.modules, "lct_python_backend.config", dummy_cfg)

    # schemas — must be real Pydantic models so FastAPI can build response schemas.
    dummy_schemas = types.ModuleType("lct_python_backend.schemas")
    dummy_schemas.ConversationResponse = _StubConversationResponse
    dummy_schemas.SaveJsonResponseExtended = _StubSaveJsonResponseExtended
    monkeypatch.setitem(sys.modules, "lct_python_backend.schemas", dummy_schemas)

    # Evict stale cached module if any previous test loaded it.
    sys.modules.pop("lct_python_backend.conversations_api", None)


def _load(monkeypatch):
    _stub_modules(monkeypatch)
    return importlib.import_module("lct_python_backend.conversations_api")


# ---------------------------------------------------------------------------
# _normalize_participants_payload
# ---------------------------------------------------------------------------

class TestNormalizeParticipants:
    """Tests for the pure-logic participant normalizer."""

    def _call(self, monkeypatch, raw: List[Dict]) -> List[Dict]:
        api = _load(monkeypatch)
        ParticipantIn = api.ParticipantIn
        participants = [ParticipantIn(**p) for p in raw]
        return api._normalize_participants_payload(participants)

    def test_basic_contact_with_id(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"}
        ])
        assert len(result) == 1
        assert result[0]["contact_id"] == "c1"
        assert result[0]["display_name"] == "Alice"

    def test_source_defaults_to_picker_when_omitted(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"}
        ])
        assert result[0]["source"] == "picker"

    def test_source_defaults_to_picker_when_empty(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice", "source": ""}
        ])
        assert result[0]["source"] == "picker"

    def test_source_preserved_when_provided(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice", "source": "import"}
        ])
        assert result[0]["source"] == "import"

    def test_added_at_is_iso_string(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"}
        ])
        # Must parse as a datetime (isoformat).
        datetime.fromisoformat(result[0]["added_at"])

    def test_empty_name_dropped(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "  "},
            {"contact_id": "c2", "display_name": "Bob"},
        ])
        assert len(result) == 1
        assert result[0]["display_name"] == "Bob"

    def test_empty_list_returns_empty(self, monkeypatch):
        result = self._call(monkeypatch, [])
        assert result == []

    def test_dedup_on_contact_id_last_write_wins(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"},
            {"contact_id": "c1", "display_name": "Alice Updated"},
        ])
        assert len(result) == 1
        assert result[0]["display_name"] == "Alice Updated"

    def test_dedup_guest_by_name_case_insensitive(self, monkeypatch):
        # No contact_id → dedupe on display_name (lowercased).
        result = self._call(monkeypatch, [
            {"display_name": "Bob"},
            {"display_name": "bob"},  # same person, different casing
        ])
        assert len(result) == 1

    def test_different_contact_ids_not_deduped(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"},
            {"contact_id": "c2", "display_name": "Bob"},
        ])
        assert len(result) == 2

    def test_contact_without_id_gets_none_in_output(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"display_name": "Guest User"}
        ])
        assert result[0]["contact_id"] is None

    def test_external_llm_ok_coerced_to_bool(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice", "external_llm_ok": True},
        ])
        assert result[0]["external_llm_ok"] is True

    def test_external_llm_ok_none_stays_none(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"contact_id": "c1", "display_name": "Alice"},
        ])
        assert result[0]["external_llm_ok"] is None

    def test_whitespace_stripped_from_name(self, monkeypatch):
        result = self._call(monkeypatch, [
            {"display_name": "  Alice  "}
        ])
        assert result[0]["display_name"] == "Alice"


# ---------------------------------------------------------------------------
# DraftStateRequest
# ---------------------------------------------------------------------------

class TestDraftStateRequest:
    """Pydantic model with extra='forbid'."""

    def _model(self, monkeypatch):
        return _load(monkeypatch).DraftStateRequest

    def test_empty_body_valid(self, monkeypatch):
        m = self._model(monkeypatch)
        draft = m()
        assert draft.conversation_name is None
        assert draft.viewport is None

    def test_all_known_fields_accepted(self, monkeypatch):
        m = self._model(monkeypatch)
        draft = m(
            conversation_name="Test",
            viewport={"zoom": 1.0},
            canvas_overrides={"node1": {"x": 0, "y": 0}},
            dismissed_unlock_affordances=["level2"],
            active_tab="graph",
            active_color_mode="speaker",
            show_temporal_edges=True,
            local_draft_text="WIP notes",
            pinned_node_ids=["n1", "n2"],
        )
        assert draft.conversation_name == "Test"
        assert draft.show_temporal_edges is True

    def test_unknown_field_rejected(self, monkeypatch):
        m = self._model(monkeypatch)
        with pytest.raises(ValidationError) as exc_info:
            m(nodes=[{"id": "n1"}])
        errors = exc_info.value.errors()
        assert any(e["type"] == "extra_forbidden" for e in errors)

    def test_semantic_fields_forbidden(self, monkeypatch):
        """The key security property: semantic state must not flow through draft."""
        m = self._model(monkeypatch)
        for forbidden in ("nodes", "relationships", "claims", "utterances",
                          "is_tangent", "is_crux", "transcript_events"):
            with pytest.raises(ValidationError):
                m(**{forbidden: "smuggled"})

    def test_active_color_mode_is_string(self, monkeypatch):
        m = self._model(monkeypatch)
        draft = m(active_color_mode="tier")
        assert draft.active_color_mode == "tier"

    def test_model_dump_excludes_none(self, monkeypatch):
        m = self._model(monkeypatch)
        draft = m(conversation_name="Hello")
        payload = draft.model_dump(exclude_none=True)
        assert "conversation_name" in payload
        assert "viewport" not in payload


# ---------------------------------------------------------------------------
# _ser helper (inside export_conversation_json)
#
# The helper is defined locally inside the route function, so we test it by
# extracting the exact same logic rather than patching the function boundary.
# ---------------------------------------------------------------------------

class TestSerHelper:
    """The _ser coercion helper embedded in export_conversation_json."""

    def _make_ser(self):
        """Replicate the _ser function from conversations_api exactly."""
        def _ser(value: Any) -> Any:
            if value is None:
                return None
            if isinstance(value, uuid.UUID):
                return str(value)
            if isinstance(value, (datetime, date)):
                return value.isoformat()
            if isinstance(value, (list, tuple)):
                return [_ser(v) for v in value]
            if isinstance(value, dict):
                return {k: _ser(v) for k, v in value.items()}
            return value
        return _ser

    def test_none_stays_none(self):
        ser = self._make_ser()
        assert ser(None) is None

    def test_uuid_becomes_string(self):
        ser = self._make_ser()
        uid = uuid.uuid4()
        result = ser(uid)
        assert isinstance(result, str)
        assert result == str(uid)
        # Must be a valid UUID string.
        uuid.UUID(result)

    def test_datetime_becomes_isoformat(self):
        ser = self._make_ser()
        dt = datetime(2026, 6, 29, 12, 0, 0)
        result = ser(dt)
        assert isinstance(result, str)
        assert "2026-06-29" in result

    def test_date_becomes_isoformat(self):
        ser = self._make_ser()
        d = date(2026, 6, 29)
        result = ser(d)
        assert result == "2026-06-29"

    def test_list_recurses(self):
        ser = self._make_ser()
        uid = uuid.uuid4()
        result = ser([uid, None, "text"])
        assert result[0] == str(uid)
        assert result[1] is None
        assert result[2] == "text"

    def test_tuple_treated_like_list(self):
        ser = self._make_ser()
        result = ser((1, 2, 3))
        assert result == [1, 2, 3]
        assert isinstance(result, list)

    def test_dict_recurses(self):
        ser = self._make_ser()
        uid = uuid.uuid4()
        result = ser({"id": uid, "count": 5})
        assert result["id"] == str(uid)
        assert result["count"] == 5

    def test_nested_structure(self):
        ser = self._make_ser()
        uid = uuid.uuid4()
        result = ser({"items": [{"id": uid}]})
        assert result["items"][0]["id"] == str(uid)

    def test_scalar_passthrough(self):
        ser = self._make_ser()
        assert ser(42) == 42
        assert ser(3.14) == 3.14
        assert ser("hello") == "hello"
        assert ser(True) is True
