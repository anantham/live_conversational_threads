import importlib
import sys
import types
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


def _load_factcheck_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.factcheck_api", None)
    return importlib.import_module("lct_python_backend.factcheck_api")


def test_parse_time_range_accepts_known_values(monkeypatch):
    factcheck_api = _load_factcheck_api_with_stubs(monkeypatch)
    assert factcheck_api._parse_time_range_to_start("all") is None
    assert factcheck_api._parse_time_range_to_start("1d") is not None
    assert factcheck_api._parse_time_range_to_start("7d") is not None
    assert factcheck_api._parse_time_range_to_start("30d") is not None


def test_parse_time_range_rejects_unknown_value(monkeypatch):
    factcheck_api = _load_factcheck_api_with_stubs(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        factcheck_api._parse_time_range_to_start("90d")

    assert exc.value.status_code == 400


def test_aggregate_cost_logs_returns_dashboard_shape(monkeypatch):
    factcheck_api = _load_factcheck_api_with_stubs(monkeypatch)
    now = datetime(2026, 2, 9, 17, 30, tzinfo=timezone.utc)

    logs = [
        SimpleNamespace(
            conversation_id="conv-1",
            feature="bias_detection",
            endpoint="bias_detection",
            model="claude-sonnet",
            total_tokens=300,
            total_cost=0.03,
            latency_ms=2100,
            started_at=now,
        ),
        SimpleNamespace(
            conversation_id="conv-2",
            feature="frame_detection",
            endpoint="frame_detection",
            model="claude-sonnet",
            total_tokens=200,
            total_cost=0.02,
            latency_ms=1900,
            started_at=now,
        ),
    ]

    payload = factcheck_api._aggregate_cost_logs(logs)
    assert payload["total_calls"] == 2
    assert payload["total_tokens"] == 500
    assert payload["total_cost"] == 0.05
    assert payload["conversations_analyzed"] == 2
    assert payload["by_feature"]["bias_detection"]["cost"] == 0.03
    assert payload["by_model"]["claude-sonnet"]["calls"] == 2
    assert len(payload["recent_calls"]) == 2
    assert payload["recent_calls"][0]["cost_usd"] == 0.03
