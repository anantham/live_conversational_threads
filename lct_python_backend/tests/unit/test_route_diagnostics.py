"""Tests for gated route-stage diagnostics.

Test Intent:
- Prove route-stage timings are default-off and only record when explicitly enabled.
- Prove the middleware emits diagnostic lines for targeted paths without lowering
  the global slow-request threshold.
"""

import logging
from types import SimpleNamespace

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from lct_python_backend.middleware import ServerTimingMiddleware
from lct_python_backend.route_diagnostics import (
    record_stage,
    should_diagnose_path,
    timed_sync_stage,
)


def _fake_request():
    return SimpleNamespace(state=SimpleNamespace())


def test_record_stage_is_default_off(monkeypatch):
    monkeypatch.delenv("LCT_ROUTE_DIAGNOSTICS", raising=False)
    request = _fake_request()

    record_stage(request, "work", 12.3)

    assert not hasattr(request.state, "server_timings")


def test_timed_sync_stage_records_when_enabled(monkeypatch):
    monkeypatch.setenv("LCT_ROUTE_DIAGNOSTICS", "1")
    request = _fake_request()

    result = timed_sync_stage(request, "work", lambda: "ok")

    assert result == "ok"
    assert len(request.state.server_timings) == 1
    name, elapsed_ms = request.state.server_timings[0]
    assert name == "work"
    assert elapsed_ms >= 0


def test_default_diagnostic_paths_include_supervised_health(monkeypatch):
    monkeypatch.setenv("LCT_ROUTE_DIAGNOSTICS", "1")

    assert should_diagnose_path("/api/import/health") is True
    assert should_diagnose_path("/api/backend-catalog") is True
    assert should_diagnose_path("/api/not-targeted") is False


def test_middleware_logs_diagnostic_target_when_enabled(monkeypatch, caplog):
    monkeypatch.setenv("LCT_ROUTE_DIAGNOSTICS", "1")
    app = FastAPI()
    app.add_middleware(ServerTimingMiddleware)

    @app.get("/api/import/health")
    async def import_health(request: Request):
        request.state.server_timings.append(("handler", 1.0))
        return {"status": "healthy"}

    caplog.set_level(logging.INFO, logger="lct_backend")
    client = TestClient(app)

    response = client.get("/api/import/health")

    assert response.status_code == 200
    assert "handler;dur=1.0" in response.headers["Server-Timing"]
    assert any("[LCT-ROUTE-DIAG] GET /api/import/health" in record.message for record in caplog.records)
