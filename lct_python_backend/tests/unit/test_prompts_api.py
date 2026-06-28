"""Unit tests for lct_python_backend.prompts_api.

Covers:
- PromptConfigUpdate / PromptRestoreRequest Pydantic models (defaults, required fields)
- Error-to-status-code mapping: KeyError→404, FileNotFoundError→404, Exception→500
- PUT /api/prompts/{name}: validation guard fires 400 when pm.validate_prompt returns valid=False
- POST /api/prompts/{name}/restore: 404 on FileNotFoundError
- POST /api/prompts/reload: success response shape
- GET /api/prompts: returns {prompts, count}
"""

import importlib
import sys
import types
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError


# ---------------------------------------------------------------------------
# Module loader — stub only prompt_manager
# ---------------------------------------------------------------------------

def _load_prompts_api(monkeypatch, pm_mock=None):
    """Load prompts_api with get_prompt_manager stubbed to return pm_mock."""
    if pm_mock is None:
        pm_mock = MagicMock()

    dummy_pm_module = types.ModuleType("lct_python_backend.services.prompt_manager")
    dummy_pm_module.get_prompt_manager = MagicMock(return_value=pm_mock)
    monkeypatch.setitem(
        sys.modules,
        "lct_python_backend.services.prompt_manager",
        dummy_pm_module,
    )

    sys.modules.pop("lct_python_backend.prompts_api", None)
    return importlib.import_module("lct_python_backend.prompts_api")


def _build_client(module):
    app = FastAPI()
    app.include_router(module.router)
    return TestClient(app)


def _make_pm(**methods):
    """Build a PromptManager mock with specified method return values / side effects."""
    pm = MagicMock()
    for name, value in methods.items():
        if isinstance(value, Exception):
            getattr(pm, name).side_effect = value
        else:
            getattr(pm, name).return_value = value
    return pm


# ---------------------------------------------------------------------------
# Pydantic model tests (no HTTP required)
# ---------------------------------------------------------------------------

class TestPromptConfigUpdate:
    def _model(self, monkeypatch):
        return _load_prompts_api(monkeypatch).PromptConfigUpdate

    def test_defaults(self, monkeypatch):
        m = self._model(monkeypatch)
        obj = m(prompt_config={"key": "value"})
        assert obj.user_id == "anonymous"
        assert obj.comment == ""

    def test_custom_user_and_comment(self, monkeypatch):
        m = self._model(monkeypatch)
        obj = m(prompt_config={}, user_id="alice", comment="hotfix")
        assert obj.user_id == "alice"
        assert obj.comment == "hotfix"

    def test_prompt_config_required(self, monkeypatch):
        m = self._model(monkeypatch)
        with pytest.raises((ValidationError, TypeError)):
            m()


class TestPromptRestoreRequest:
    def _model(self, monkeypatch):
        return _load_prompts_api(monkeypatch).PromptRestoreRequest

    def test_defaults(self, monkeypatch):
        m = self._model(monkeypatch)
        obj = m(version_timestamp="2026-06-29T00:00:00")
        assert obj.user_id == "anonymous"
        assert obj.version_timestamp == "2026-06-29T00:00:00"

    def test_version_timestamp_required(self, monkeypatch):
        m = self._model(monkeypatch)
        with pytest.raises((ValidationError, TypeError)):
            m()


# ---------------------------------------------------------------------------
# GET /api/prompts
# ---------------------------------------------------------------------------

class TestListPrompts:
    def test_returns_count_and_list(self, monkeypatch):
        pm = _make_pm(list_prompts=["graph", "factcheck", "diarize"])
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts")
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 3
        assert "graph" in body["prompts"]

    def test_exception_returns_500(self, monkeypatch):
        pm = _make_pm(list_prompts=RuntimeError("disk full"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# GET /api/prompts/config
# ---------------------------------------------------------------------------

class TestGetPromptsConfig:
    def test_returns_config_dict(self, monkeypatch):
        pm = _make_pm(get_prompts_config={"version": 1, "prompts": {}})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/config")
        assert resp.status_code == 200
        assert resp.json()["version"] == 1

    def test_exception_returns_500(self, monkeypatch):
        pm = _make_pm(get_prompts_config=IOError("file missing"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/config")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# GET /api/prompts/{prompt_name}
# ---------------------------------------------------------------------------

class TestGetPrompt:
    def test_returns_prompt(self, monkeypatch):
        pm = _make_pm(get_prompt={"template": "you are..."})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph")
        assert resp.status_code == 200
        assert resp.json()["template"] == "you are..."

    def test_key_error_returns_404(self, monkeypatch):
        pm = _make_pm(get_prompt=KeyError("graph"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph")
        assert resp.status_code == 404

    def test_generic_exception_returns_500(self, monkeypatch):
        pm = _make_pm(get_prompt=ValueError("corrupt"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# GET /api/prompts/{prompt_name}/metadata
# ---------------------------------------------------------------------------

class TestGetPromptMetadata:
    def test_returns_metadata(self, monkeypatch):
        pm = _make_pm(get_prompt_metadata={"model": "claude-opus-4-8", "temperature": 0.7})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph/metadata")
        assert resp.status_code == 200
        assert resp.json()["model"] == "claude-opus-4-8"

    def test_key_error_returns_404(self, monkeypatch):
        pm = _make_pm(get_prompt_metadata=KeyError("graph"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/missing/metadata")
        assert resp.status_code == 404

    def test_generic_exception_returns_500(self, monkeypatch):
        pm = _make_pm(get_prompt_metadata=RuntimeError("boom"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph/metadata")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# PUT /api/prompts/{prompt_name}
# ---------------------------------------------------------------------------

class TestUpdatePrompt:
    def test_validation_failure_returns_400(self, monkeypatch):
        pm = MagicMock()
        pm.validate_prompt.return_value = {"valid": False, "errors": ["template missing"]}
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.put(
            "/api/prompts/graph",
            json={"prompt_config": {}, "user_id": "alice"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "errors" in body.get("detail", {})

    def test_valid_config_saves_and_returns_result(self, monkeypatch):
        pm = MagicMock()
        pm.validate_prompt.return_value = {"valid": True, "errors": []}
        pm.save_prompt.return_value = {"success": True, "version": "v2"}
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.put(
            "/api/prompts/graph",
            json={"prompt_config": {"template": "hi"}, "user_id": "alice"},
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_generic_exception_returns_500(self, monkeypatch):
        pm = MagicMock()
        pm.validate_prompt.return_value = {"valid": True, "errors": []}
        pm.save_prompt.side_effect = OSError("write failed")
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.put(
            "/api/prompts/graph",
            json={"prompt_config": {"template": "hi"}},
        )
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# DELETE /api/prompts/{prompt_name}
# ---------------------------------------------------------------------------

class TestDeletePrompt:
    def test_success(self, monkeypatch):
        pm = _make_pm(delete_prompt={"success": True})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.delete("/api/prompts/graph")
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_key_error_returns_404(self, monkeypatch):
        pm = _make_pm(delete_prompt=KeyError("graph"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.delete("/api/prompts/missing")
        assert resp.status_code == 404

    def test_generic_exception_returns_500(self, monkeypatch):
        pm = _make_pm(delete_prompt=RuntimeError("locked"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.delete("/api/prompts/graph")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# GET /api/prompts/{prompt_name}/history
# ---------------------------------------------------------------------------

class TestGetPromptHistory:
    def test_returns_history_with_count(self, monkeypatch):
        pm = _make_pm(get_prompt_history=[{"version": "v1"}, {"version": "v2"}])
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph/history")
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 2
        assert body["prompt_name"] == "graph"

    def test_limit_query_param_default(self, monkeypatch):
        pm = MagicMock()
        pm.get_prompt_history.return_value = []
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        client.get("/api/prompts/graph/history")
        pm.get_prompt_history.assert_called_once_with("graph", 10)

    def test_limit_query_param_custom(self, monkeypatch):
        pm = MagicMock()
        pm.get_prompt_history.return_value = []
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        client.get("/api/prompts/graph/history?limit=5")
        pm.get_prompt_history.assert_called_once_with("graph", 5)

    def test_exception_returns_500(self, monkeypatch):
        pm = _make_pm(get_prompt_history=RuntimeError("gone"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.get("/api/prompts/graph/history")
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/prompts/{prompt_name}/restore
# ---------------------------------------------------------------------------

class TestRestorePromptVersion:
    def test_success(self, monkeypatch):
        pm = _make_pm(restore_version={"success": True, "version": "v1"})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post(
            "/api/prompts/graph/restore",
            json={"version_timestamp": "2026-06-01T00:00:00"},
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_file_not_found_returns_404(self, monkeypatch):
        pm = _make_pm(restore_version=FileNotFoundError("version not found"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post(
            "/api/prompts/graph/restore",
            json={"version_timestamp": "bad-ts"},
        )
        assert resp.status_code == 404

    def test_generic_exception_returns_500(self, monkeypatch):
        pm = _make_pm(restore_version=RuntimeError("crash"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post(
            "/api/prompts/graph/restore",
            json={"version_timestamp": "ts"},
        )
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/prompts/{prompt_name}/validate
# ---------------------------------------------------------------------------

class TestValidatePromptConfig:
    def test_returns_validation_result(self, monkeypatch):
        pm = _make_pm(validate_prompt={"valid": True, "errors": []})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post(
            "/api/prompts/graph/validate",
            json={"template": "hi"},
        )
        assert resp.status_code == 200
        assert resp.json()["valid"] is True

    def test_invalid_result_still_200(self, monkeypatch):
        pm = _make_pm(validate_prompt={"valid": False, "errors": ["template missing"]})
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post("/api/prompts/graph/validate", json={})
        assert resp.status_code == 200
        assert resp.json()["valid"] is False

    def test_exception_returns_500(self, monkeypatch):
        pm = _make_pm(validate_prompt=RuntimeError("schema broken"))
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post("/api/prompts/graph/validate", json={})
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/prompts/reload
# ---------------------------------------------------------------------------

class TestReloadPrompts:
    def test_success_returns_timestamp(self, monkeypatch):
        pm = MagicMock()
        pm.reload.return_value = None
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post("/api/prompts/reload")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "timestamp" in body

    def test_exception_returns_500(self, monkeypatch):
        pm = MagicMock()
        pm.reload.side_effect = IOError("cannot reload")
        module = _load_prompts_api(monkeypatch, pm)
        client = _build_client(module)
        resp = client.post("/api/prompts/reload")
        assert resp.status_code == 500
