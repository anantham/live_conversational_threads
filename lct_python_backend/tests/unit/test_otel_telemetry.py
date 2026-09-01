"""Behavioral contract for the LCT OpenTelemetry boundary.

Test intent:
- development remains uninstrumented unless explicitly enabled;
- a real FastAPI request emits a standard server span;
- a real async HTTPX request emits a client span with a sanitized URL;
- URL credentials, query values, and fragments never appear in exported spans;
- shutdown is repeatable and does not leave global instrumentors active.
- every supported dependency manifest pins the same complete telemetry stack.
"""

import asyncio
import json
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from lct_python_backend.telemetry import configure_telemetry


REPO_ROOT = Path(__file__).resolve().parents[3]
EXPECTED_OTEL_PINS = {
    "opentelemetry-api": "1.41.1",
    "opentelemetry-sdk": "1.41.1",
    "opentelemetry-exporter-otlp-proto-http": "1.41.1",
    "opentelemetry-instrumentation-fastapi": "0.62b1",
    "opentelemetry-instrumentation-httpx": "0.62b1",
    "opentelemetry-instrumentation-sqlalchemy": "0.62b1",
    "opentelemetry-instrumentation-system-metrics": "0.62b1",
}


def _otel_pins(path: Path) -> dict[str, str]:
    pins = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if line.startswith("opentelemetry-") and "==" in line:
            name, version = line.split("==", 1)
            pins[name] = version
    return pins


def test_deployment_manifests_pin_complete_matching_telemetry_stack():
    assert _otel_pins(REPO_ROOT / "requirements.txt") == EXPECTED_OTEL_PINS
    assert (
        _otel_pins(REPO_ROOT / "lct_python_backend" / "requirements.txt")
        == EXPECTED_OTEL_PINS
    )


def test_development_telemetry_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv("LCT_TELEMETRY_ENABLED", raising=False)
    app = FastAPI()

    runtime = configure_telemetry(app, environment="development")

    assert runtime is None


def test_fastapi_span_redacts_query_credentials_and_fragment(monkeypatch):
    monkeypatch.setenv("LCT_TRACE_SAMPLE_RATIO", "1")
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    app = FastAPI()

    @app.get("/probe/{probe_id}")
    async def probe(probe_id: str):
        return {"probe_id": probe_id}

    runtime = configure_telemetry(
        app,
        environment="test",
        span_exporter=span_exporter,
        metric_readers=[metric_reader],
        force_enabled=True,
    )
    assert runtime is not None

    with TestClient(app) as client:
        response = client.get(
            "/probe/visible?token=never-export-this#private-fragment"
        )

    assert response.status_code == 200
    spans = span_exporter.get_finished_spans()
    server_spans = [
        span
        for span in spans
        if span.attributes.get("http.route") == "/probe/{probe_id}"
    ]
    assert server_spans, "Expected a FastAPI server span for the public route"
    exported = json.dumps(
        [
            {
                "name": span.name,
                "attributes": dict(span.attributes),
            }
            for span in spans
        ],
        default=str,
    )
    assert "never-export-this" not in exported
    assert "private-fragment" not in exported
    assert "token=" not in exported
    assert server_spans[0].attributes["url.full"] == "/probe/visible"

    asyncio.run(runtime.shutdown())
    asyncio.run(runtime.shutdown())


def test_async_httpx_span_redacts_query_credentials_and_fragment(monkeypatch):
    monkeypatch.setenv("LCT_TRACE_SAMPLE_RATIO", "1")
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    runtime = configure_telemetry(
        FastAPI(),
        environment="test",
        span_exporter=span_exporter,
        metric_readers=[metric_reader],
        force_enabled=True,
    )
    assert runtime is not None

    async def request_unavailable_loopback_dependency() -> None:
        async with httpx.AsyncClient(timeout=0.2) as client:
            try:
                await client.get(
                    "http://user:never-export-this@127.0.0.1:9/dependency"
                    "?token=private-query#private-fragment"
                )
            except httpx.TransportError:
                pass

    asyncio.run(request_unavailable_loopback_dependency())

    spans = span_exporter.get_finished_spans()
    client_spans = [span for span in spans if span.kind.name == "CLIENT"]
    assert client_spans, "Expected an HTTPX client span for the failed request"
    exported = json.dumps(
        [
            {
                "name": span.name,
                "attributes": dict(span.attributes),
            }
            for span in client_spans
        ],
        default=str,
    )
    assert "never-export-this" not in exported
    assert "private-query" not in exported
    assert "private-fragment" not in exported
    assert "token=" not in exported
    assert client_spans[0].attributes["url.full"] == (
        "http://127.0.0.1:9/dependency"
    )

    asyncio.run(runtime.shutdown())
