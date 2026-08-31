"""Behavioral coverage for ADR-064 facts-only gateway telemetry.

The gateway is exercised through its public chat, chat_sync, and embedding
methods. A recording store stands in for the durable database boundary so the
tests assert observable fact envelopes rather than ORM helper call order.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from lct_python_backend.models import LLMCallFact
from lct_python_backend.services.llm_call_facts import (
    LLMCallFactEvent,
)
from lct_python_backend.services.llm_call_fact_store import DatabaseLLMCallFactStore
from lct_python_backend.services.llm_gateway import Capability, LlmGateway
from lct_python_backend.services.local_llm_client import ProviderResult


class RecordingFactStore:
    def __init__(self) -> None:
        self.events: list[LLMCallFactEvent] = []

    async def record_async(self, event: LLMCallFactEvent) -> bool:
        self.events.append(event)
        return True

    def record_sync(self, event: LLMCallFactEvent) -> bool:
        self.events.append(event)
        return True


class FailingFactStore:
    async def record_async(self, event: LLMCallFactEvent) -> bool:
        raise RuntimeError("telemetry database unavailable")

    def record_sync(self, event: LLMCallFactEvent) -> bool:
        raise RuntimeError("telemetry database unavailable")


def _result(**overrides) -> ProviderResult:
    values = {
        "data": {"ok": True},
        "provider_id": "asus_ollama",
        "provider_name": "Asus Ollama",
        "model": "qwen3.8:latest",
        "base_url": "http://local.invalid",
        "provider_type": "openai_compatible",
        "attempt_number": 2,
        "total_providers_tried": 2,
        "prompt_tokens": 120,
        "completion_tokens": 33,
        "total_tokens": 153,
        "provider_latency_ms": 842.5,
        "finish_reason": "stop",
        "request_id": "req-17",
    }
    values.update(overrides)
    return ProviderResult(**values)


@pytest.mark.asyncio
async def test_async_chat_records_actual_fallback_and_correlation(monkeypatch):
    async def fake_chat(*_args, **_kwargs):
        return _result()

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.chat_with_provider_fallback",
        fake_chat,
    )
    store = RecordingFactStore()
    gateway = LlmGateway(fact_store=store)

    result = await gateway.chat(
        [{"role": "user", "content": "private text never enters telemetry"}],
        capability=Capability.CHAT_JSON_OBJECT,
        route_id="graph_generation",
        conversation_id="conversation-17",
        session_id="session-4",
        prompt_name="aggregate_threads",
        prompt_version="v8",
    )

    assert result.data == {"ok": True}
    assert len(store.events) == 1
    event = store.events[0]
    assert event.provider_id == "asus_ollama"
    assert event.model == "qwen3.8:latest"
    assert event.capability == "chat_json_object"
    assert event.route_id == "graph_generation"
    assert event.attempt_number == 2
    assert event.total_providers_tried == 2
    assert event.prompt_tokens == 120
    assert event.completion_tokens == 33
    assert event.total_tokens == 153
    assert event.finish_reason == "stop"
    assert event.conversation_id == "conversation-17"
    assert event.session_id == "session-4"
    assert event.prompt_name == "aggregate_threads"
    assert event.prompt_version == "v8"
    assert event.status == "success"
    assert "private text" not in repr(event)


def test_sync_chat_preserves_missing_usage_as_null(monkeypatch):
    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.chat_with_provider_fallback_sync",
        lambda *_args, **_kwargs: _result(
            attempt_number=1,
            total_providers_tried=1,
            prompt_tokens=None,
            completion_tokens=None,
            total_tokens=None,
        ),
    )
    store = RecordingFactStore()
    gateway = LlmGateway(fact_store=store)

    result = gateway.chat_sync(
        [{"role": "user", "content": "hello"}],
        capability=Capability.CHAT,
    )

    assert result.data == {"ok": True}
    event = store.events[0]
    assert event.prompt_tokens is None
    assert event.completion_tokens is None
    assert event.total_tokens is None


@pytest.mark.asyncio
async def test_embedding_records_embed_capability_and_actual_model(monkeypatch):
    async def fake_embed(**_kwargs):
        return _result(
            data=[0.1, 0.2],
            provider_id="m5_embeddings",
            model="qwen3-embedding:0.6b",
            attempt_number=1,
            total_providers_tried=2,
            prompt_tokens=19,
            completion_tokens=None,
            total_tokens=19,
            finish_reason=None,
        )

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway._embed_with_provider_fallback",
        fake_embed,
    )
    store = RecordingFactStore()
    gateway = LlmGateway(fact_store=store)

    vector = await gateway.embed("hello", route_id="semantic_edges")

    assert vector == [0.1, 0.2]
    event = store.events[0]
    assert event.capability == "embed"
    assert event.provider_id == "m5_embeddings"
    assert event.model == "qwen3-embedding:0.6b"
    assert event.route_id == "semantic_edges"


@pytest.mark.asyncio
async def test_total_failure_records_safe_code_without_exception_body(monkeypatch):
    secret = "PRIVATE_TRANSCRIPT_SENTINEL"

    async def fail(*_args, **_kwargs):
        raise RuntimeError(f"All LLM providers failed: upstream echoed {secret}")

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.chat_with_provider_fallback",
        fail,
    )
    store = RecordingFactStore()
    gateway = LlmGateway(fact_store=store)

    with pytest.raises(RuntimeError, match="All LLM providers failed"):
        await gateway.chat(
            [{"role": "user", "content": secret}],
            capability=Capability.CHAT,
            route_id="privacy_republication",
        )

    assert len(store.events) == 1
    payload = asdict(store.events[0])
    assert payload["status"] == "error"
    assert payload["error_code"] == "all_providers_failed"
    assert payload["provider_id"] is None
    assert payload["model"] is None
    assert secret not in repr(payload)


@pytest.mark.asyncio
async def test_telemetry_failure_never_changes_successful_model_result(monkeypatch):
    async def fake_chat(*_args, **_kwargs):
        return _result()

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.chat_with_provider_fallback",
        fake_chat,
    )
    gateway = LlmGateway(fact_store=FailingFactStore())

    result = await gateway.chat([{"role": "user", "content": "hello"}])

    assert result.data == {"ok": True}


def test_relational_fact_schema_excludes_content_and_price_fields():
    columns = set(LLMCallFact.__table__.columns.keys())

    assert {"provider_id", "model", "capability", "status", "latency_ms"} <= columns
    forbidden = {"cost", "price", "prompt_body", "response", "reasoning", "messages"}
    assert not any(any(token in column for token in forbidden) for column in columns)


def test_database_store_persists_a_queryable_fact(monkeypatch, tmp_path):
    database_path = tmp_path / "llm-facts.sqlite3"
    database_url = f"sqlite:///{database_path.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    engine = create_engine(database_url)
    LLMCallFact.__table__.create(engine)
    now = datetime.now(timezone.utc)
    event = LLMCallFactEvent(
        capability="chat",
        status="success",
        latency_ms=41,
        started_at=now,
        completed_at=now,
        provider_id="m5_ollama",
        model="qwen3.8:latest",
        prompt_tokens=None,
        completion_tokens=7,
        total_tokens=None,
    )

    assert DatabaseLLMCallFactStore().record_sync(event) is True

    with Session(engine) as session:
        row = session.execute(select(LLMCallFact)).scalar_one()
    assert row.provider_id == "m5_ollama"
    assert row.prompt_tokens is None
    assert row.completion_tokens == 7
    assert row.total_tokens is None
