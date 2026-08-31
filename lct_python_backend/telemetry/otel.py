"""Standards-based, privacy-bounded OpenTelemetry wiring for LCT."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit, urlunsplit

logger = logging.getLogger(__name__)

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}
_runtime: Optional["TelemetryRuntime"] = None
_instrumented_engine_ids: set[int] = set()


def telemetry_enabled(environment: Optional[str] = None) -> bool:
    """Return whether telemetry should run for this process."""
    configured = os.getenv("LCT_TELEMETRY_ENABLED", "").strip().lower()
    if configured in _TRUE_VALUES:
        return True
    if configured in _FALSE_VALUES:
        return False
    effective_environment = (
        environment or os.getenv("ENVIRONMENT", "development")
    ).strip().lower()
    return effective_environment == "production"


def _sample_ratio() -> float:
    try:
        return max(
            0.0,
            min(float(os.getenv("LCT_TRACE_SAMPLE_RATIO", "1.0")), 1.0),
        )
    except ValueError:
        logger.warning("[OTEL] invalid LCT_TRACE_SAMPLE_RATIO; using 1.0")
        return 1.0


def _safe_url(raw_url: Any) -> str:
    """Keep scheme, host, and path while dropping credentials and query data."""
    if isinstance(raw_url, bytes):
        raw_url = raw_url.decode("utf-8", errors="replace")
    parsed = urlsplit(str(raw_url or ""))
    if not parsed.scheme and not parsed.netloc:
        return parsed.path or "/"
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path or "/", "", ""))


def _server_request_hook(span, scope: dict) -> None:
    if not span or not span.is_recording():
        return
    path = str(scope.get("path") or "/")
    span.set_attribute("url.full", path)
    span.set_attribute("http.url", path)
    span.set_attribute("http.target", path)


def _httpx_request_hook(span, request_info) -> None:
    if not span or not span.is_recording():
        return
    safe_url = _safe_url(getattr(request_info, "url", ""))
    span.set_attribute("url.full", safe_url)
    span.set_attribute("http.url", safe_url)
    span.set_attribute("http.target", urlsplit(safe_url).path or "/")


async def _async_httpx_request_hook(span, request_info) -> None:
    _httpx_request_hook(span, request_info)


@dataclass
class RuntimeMetricsMonitor:
    meter_provider: Any
    interval_seconds: float = 10.0
    _task: Optional[asyncio.Task] = field(default=None, init=False)
    _event_loop_lag_seconds: float = field(default=0.0, init=False)
    _borrowed_tokens: float = field(default=0.0, init=False)
    _total_tokens: float = field(default=0.0, init=False)
    _warned: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        from opentelemetry.metrics import Observation

        meter = self.meter_provider.get_meter("lct.runtime", "1.0")
        meter.create_observable_gauge(
            "lct.event_loop.lag",
            callbacks=[
                lambda _options: [Observation(self._event_loop_lag_seconds)]
            ],
            unit="s",
            description="Delay beyond the scheduled event-loop wake-up time.",
        )
        meter.create_observable_gauge(
            "lct.anyio.worker.borrowed",
            callbacks=[lambda _options: [Observation(self._borrowed_tokens)]],
            unit="{token}",
            description="AnyIO worker tokens currently borrowed.",
        )
        meter.create_observable_gauge(
            "lct.anyio.worker.total",
            callbacks=[lambda _options: [Observation(self._total_tokens)]],
            unit="{token}",
            description="AnyIO worker-token admission limit.",
        )

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(
                self._run(),
                name="lct-otel-runtime-metrics",
            )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        import anyio.to_thread

        loop = asyncio.get_running_loop()
        while True:
            expected = loop.time() + self.interval_seconds
            await asyncio.sleep(self.interval_seconds)
            self._event_loop_lag_seconds = max(0.0, loop.time() - expected)
            try:
                limiter = anyio.to_thread.current_default_thread_limiter()
                self._borrowed_tokens = float(limiter.borrowed_tokens)
                self._total_tokens = float(limiter.total_tokens)
                self._warned = False
            except Exception:
                if not self._warned:
                    logger.exception(
                        "[OTEL] failed to sample AnyIO worker-token pressure"
                    )
                    self._warned = True


@dataclass
class TelemetryRuntime:
    tracer_provider: Any
    meter_provider: Any
    app: Any
    monitor: RuntimeMetricsMonitor
    system_metrics_instrumentor: Any
    _shutdown: bool = field(default=False, init=False)

    async def start(self) -> None:
        await self.monitor.start()

    async def shutdown(self) -> None:
        global _runtime
        if self._shutdown:
            return
        self._shutdown = True
        await self.monitor.stop()
        try:
            self.tracer_provider.force_flush(timeout_millis=5000)
            self.meter_provider.force_flush(timeout_millis=5000)
        except Exception:
            logger.exception("[OTEL] telemetry flush failed during shutdown")
        self.tracer_provider.shutdown()
        self.meter_provider.shutdown()
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
            from opentelemetry.instrumentation.sqlalchemy import (
                SQLAlchemyInstrumentor,
            )

            FastAPIInstrumentor.uninstrument_app(self.app)
            HTTPXClientInstrumentor().uninstrument()
            SQLAlchemyInstrumentor().uninstrument()
            self.system_metrics_instrumentor.uninstrument()
        except Exception:
            logger.exception("[OTEL] instrumentor cleanup failed during shutdown")
        _instrumented_engine_ids.clear()
        if _runtime is self:
            _runtime = None


def configure_telemetry(
    app,
    *,
    environment: Optional[str] = None,
    span_exporter: Any = None,
    metric_readers: Optional[Iterable[Any]] = None,
    force_enabled: bool = False,
) -> Optional[TelemetryRuntime]:
    """Instrument an application without making telemetry a startup dependency."""
    global _runtime
    if _runtime is not None:
        return _runtime
    if not force_enabled and not telemetry_enabled(environment):
        logger.info(
            "[OTEL] disabled (set LCT_TELEMETRY_ENABLED=1 to enable)"
        )
        return None

    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.system_metrics import (
            SystemMetricsInstrumentor,
        )
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import (
            PeriodicExportingMetricReader,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import (
            BatchSpanProcessor,
            SimpleSpanProcessor,
        )
        from opentelemetry.sdk.trace.sampling import (
            ParentBased,
            TraceIdRatioBased,
        )

        os.environ.setdefault(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "http://127.0.0.1:4318",
        )
        os.environ.setdefault("OTEL_EXPORTER_OTLP_TIMEOUT", "3")
        resource = Resource.create(
            {
                "service.name": os.getenv(
                    "OTEL_SERVICE_NAME",
                    "lct-backend",
                ),
                "service.namespace": "temporal-coordination",
                "deployment.environment.name": environment
                or os.getenv("ENVIRONMENT", "development"),
            }
        )

        tracer_provider = TracerProvider(
            resource=resource,
            sampler=ParentBased(TraceIdRatioBased(_sample_ratio())),
        )
        if span_exporter is None:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )

            span_exporter = OTLPSpanExporter()
            tracer_provider.add_span_processor(
                BatchSpanProcessor(span_exporter)
            )
        else:
            tracer_provider.add_span_processor(
                SimpleSpanProcessor(span_exporter)
            )

        if metric_readers is None:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
                OTLPMetricExporter,
            )

            metric_readers = [
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(),
                    export_interval_millis=10_000,
                    export_timeout_millis=3_000,
                )
            ]
        meter_provider = MeterProvider(
            resource=resource,
            metric_readers=list(metric_readers),
        )

        FastAPIInstrumentor.instrument_app(
            app,
            server_request_hook=_server_request_hook,
            tracer_provider=tracer_provider,
            meter_provider=meter_provider,
        )
        HTTPXClientInstrumentor().instrument(
            request_hook=_httpx_request_hook,
            async_request_hook=_async_httpx_request_hook,
            tracer_provider=tracer_provider,
            meter_provider=meter_provider,
        )
        system_metrics = SystemMetricsInstrumentor(
            config={
                "system.cpu.utilization": ["idle", "user", "system"],
                "system.memory.utilization": ["used", "free"],
                "system.thread_count": None,
                "process.cpu.utilization": None,
                "process.memory.usage": None,
                "process.memory.virtual": None,
                "process.thread.count": None,
            }
        )
        system_metrics.instrument(meter_provider=meter_provider)

        monitor = RuntimeMetricsMonitor(meter_provider=meter_provider)
        _runtime = TelemetryRuntime(
            tracer_provider=tracer_provider,
            meter_provider=meter_provider,
            app=app,
            monitor=monitor,
            system_metrics_instrumentor=system_metrics,
        )
        logger.info(
            "[OTEL] enabled service=%s endpoint=%s sample_ratio=%.3f",
            os.getenv("OTEL_SERVICE_NAME", "lct-backend"),
            os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
            _sample_ratio(),
        )
        return _runtime
    except Exception:
        logger.exception(
            "[OTEL] setup failed; application will continue without OTLP telemetry"
        )
        return None


def instrument_sqlalchemy_engine(async_engine) -> None:
    """Attach standard SQLAlchemy spans to a lazily-created async engine."""
    if _runtime is None or async_engine is None:
        return
    engine_id = id(async_engine)
    if engine_id in _instrumented_engine_ids:
        return
    try:
        from opentelemetry.instrumentation.sqlalchemy import (
            SQLAlchemyInstrumentor,
        )

        SQLAlchemyInstrumentor().instrument(
            engine=async_engine.sync_engine,
            tracer_provider=_runtime.tracer_provider,
            meter_provider=_runtime.meter_provider,
        )
        _instrumented_engine_ids.add(engine_id)
        logger.info("[OTEL] SQLAlchemy engine instrumentation enabled")
    except Exception:
        logger.exception(
            "[OTEL] SQLAlchemy instrumentation failed; database remains available"
        )
