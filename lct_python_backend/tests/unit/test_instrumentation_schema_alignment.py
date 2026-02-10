from datetime import date, datetime, timezone
from types import SimpleNamespace
import sys
import types

import pytest

from lct_python_backend.instrumentation.aggregation import CostAggregator
from lct_python_backend.instrumentation.decorators import APICallTracker


class DummyScalarResult:
    def __init__(self, values):
        self._values = values

    def all(self):
        return self._values


class DummyExecuteResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return DummyScalarResult(self._values)

    def all(self):
        return self._values


class DummySession:
    def __init__(self, values):
        self._values = values
        self.added = []
        self.commits = 0

    async def execute(self, _statement):
        return DummyExecuteResult(self._values)

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1


@pytest.mark.asyncio
async def test_api_call_tracker_maps_to_apicallslog_fields(monkeypatch):
    class DummyAPICallsLog:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    dummy_models = types.ModuleType("lct_python_backend.models")
    dummy_models.APICallsLog = DummyAPICallsLog
    monkeypatch.setitem(sys.modules, "lct_python_backend.models", dummy_models)

    db = DummySession(values=[])
    tracker = APICallTracker(db_connection=db)

    ts = datetime(2026, 2, 9, 17, 0, tzinfo=timezone.utc)
    await tracker.log_api_call(
        call_id="11111111-1111-1111-1111-111111111111",
        endpoint="test_endpoint",
        conversation_id="22222222-2222-2222-2222-222222222222",
        model="gpt-4",
        input_tokens=100,
        output_tokens=50,
        total_tokens=150,
        cost_usd=0.123,
        latency_ms=250,
        timestamp=ts,
        success=True,
        metadata={"request_id": "req-123"},
    )

    assert db.commits == 1
    assert len(db.added) == 1

    saved = db.added[0]
    assert saved.endpoint == "test_endpoint"
    assert saved.feature == "test_endpoint"
    assert saved.provider == "openai"
    assert saved.prompt_tokens == 100
    assert saved.completion_tokens == 50
    assert saved.total_tokens == 150
    assert saved.total_cost == 0.123
    assert saved.status == "success"
    assert saved.request_id == "req-123"


@pytest.mark.asyncio
async def test_cost_aggregator_reads_total_cost_and_started_at_fields():
    logs = [
        SimpleNamespace(
            total_cost=1.25,
            total_tokens=500,
            model="gpt-4",
            endpoint="feature_a",
            started_at=datetime(2026, 2, 8, 12, 0, tzinfo=timezone.utc),
            conversation_id="conv-1",
            status="success",
        ),
        SimpleNamespace(
            total_cost=0.75,
            total_tokens=300,
            model="claude-3-sonnet-20240229",
            endpoint="feature_b",
            started_at=datetime(2026, 2, 8, 13, 0, tzinfo=timezone.utc),
            conversation_id="conv-1",
            status="success",
        ),
    ]

    db = DummySession(values=logs)
    aggregator = CostAggregator(db)

    daily = await aggregator.aggregate_daily(date(2026, 2, 8))
    assert daily.total_cost == 2.0
    assert daily.total_tokens == 800
    assert daily.cost_by_endpoint["feature_a"] == 1.25
    assert daily.cost_by_model["gpt-4"] == 1.25

    conversation = await aggregator.get_conversation_cost("33333333-3333-3333-3333-333333333333")
    assert conversation.total_cost == 2.0
    assert conversation.total_calls == 2
    assert conversation.first_call == logs[0].started_at
    assert conversation.last_call == logs[-1].started_at
