"""Decorators for automatic API-call tracking and cost logging."""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable, Dict, Optional

from .cost_calculator import calculate_cost
from .cost_tracking_mapper import build_api_calls_log_record, build_memory_log_entry
from .response_parsing import parse_response_metrics

logger = logging.getLogger(__name__)


class APICallTracker:
    """Track API calls and persist them when a DB session is available."""

    def __init__(self, db_connection=None):
        """Initialize the tracker with an optional database connection."""
        self.db = db_connection
        self.call_logs = []  # In-memory buffer if DB not available

    async def log_api_call(
        self,
        call_id: str,
        endpoint: str,
        conversation_id: Optional[str],
        model: str,
        input_tokens: int,
        output_tokens: int,
        total_tokens: int,
        cost_usd: float,
        latency_ms: int,
        timestamp: datetime,
        success: bool,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Log an API call to DB when possible, otherwise append to memory."""
        log_entry = build_memory_log_entry(
            call_id=call_id,
            endpoint=endpoint,
            conversation_id=conversation_id,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            timestamp=timestamp,
            success=success,
            error_message=error_message,
            metadata=metadata,
        )

        if self.db and hasattr(self.db, "add") and hasattr(self.db, "commit"):
            try:
                from lct_python_backend.models import APICallsLog

                api_log = build_api_calls_log_record(
                    api_calls_log_cls=APICallsLog,
                    call_id=call_id,
                    endpoint=endpoint,
                    conversation_id=conversation_id,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    success=success,
                    error_message=error_message,
                    metadata=metadata,
                )
                self.db.add(api_log)
                await self.db.commit()
                return
            except Exception as exc:
                logger.exception("Failed to log API call to database: %s", str(exc))
                log_entry["db_error"] = str(exc)

        self.call_logs.append(log_entry)

    def get_in_memory_logs(self):
        """Get in-memory logs (for testing or when DB unavailable)."""
        return self.call_logs


# Global tracker instance
_global_tracker = APICallTracker()


def set_db_connection(db):
    """Set the database connection for the global tracker."""
    _global_tracker.db = db


def get_tracker() -> APICallTracker:
    """Get the global tracker instance."""
    return _global_tracker


def _extract_conversation_id(
    *,
    args: tuple,
    kwargs: dict,
    extract_conversation_id: Optional[Callable],
    allow_first_arg_attribute: bool,
) -> Optional[Any]:
    if extract_conversation_id:
        return extract_conversation_id(*args, **kwargs)
    if "conversation_id" in kwargs:
        return kwargs["conversation_id"]
    if allow_first_arg_attribute and len(args) > 0 and hasattr(args[0], "conversation_id"):
        return args[0].conversation_id
    return None


def _calculate_call_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    total_tokens = input_tokens + output_tokens
    if not model or total_tokens <= 0:
        return 0.0

    try:
        return calculate_cost(model, input_tokens, output_tokens)
    except ValueError as exc:
        logger.warning("Could not calculate cost for model '%s': %s", model, str(exc))
        return 0.0


def track_api_call(
    endpoint_name: str,
    extract_conversation_id: Optional[Callable] = None,
):
    """Decorator that measures latency, token usage, and call cost."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def async_wrapper(*args, **kwargs) -> Any:
            call_id = str(uuid.uuid4())
            start_time = time.time()
            timestamp = datetime.now(timezone.utc)

            conversation_id = _extract_conversation_id(
                args=args,
                kwargs=kwargs,
                extract_conversation_id=extract_conversation_id,
                allow_first_arg_attribute=True,
            )

            try:
                response = await func(*args, **kwargs)
                latency_ms = int((time.time() - start_time) * 1000)

                parsed = parse_response_metrics(response)
                total_tokens = parsed.input_tokens + parsed.output_tokens
                cost_usd = _calculate_call_cost(parsed.model, parsed.input_tokens, parsed.output_tokens)

                await _global_tracker.log_api_call(
                    call_id=call_id,
                    endpoint=endpoint_name,
                    conversation_id=conversation_id,
                    model=parsed.model,
                    input_tokens=parsed.input_tokens,
                    output_tokens=parsed.output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    success=True,
                    metadata=parsed.metadata,
                )

                return response

            except Exception as exc:
                latency_ms = int((time.time() - start_time) * 1000)

                await _global_tracker.log_api_call(
                    call_id=call_id,
                    endpoint=endpoint_name,
                    conversation_id=conversation_id,
                    model="unknown",
                    input_tokens=0,
                    output_tokens=0,
                    total_tokens=0,
                    cost_usd=0.0,
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    success=False,
                    error_message=str(exc),
                )

                raise

        @wraps(func)
        def sync_wrapper(*args, **kwargs) -> Any:
            """Synchronous wrapper for non-async functions."""
            call_id = str(uuid.uuid4())
            start_time = time.time()
            timestamp = datetime.now(timezone.utc)

            conversation_id = _extract_conversation_id(
                args=args,
                kwargs=kwargs,
                extract_conversation_id=extract_conversation_id,
                allow_first_arg_attribute=False,
            )

            try:
                response = func(*args, **kwargs)
                latency_ms = int((time.time() - start_time) * 1000)

                parsed = parse_response_metrics(response)
                total_tokens = parsed.input_tokens + parsed.output_tokens
                cost_usd = _calculate_call_cost(parsed.model, parsed.input_tokens, parsed.output_tokens)

                log_entry = build_memory_log_entry(
                    call_id=call_id,
                    endpoint=endpoint_name,
                    conversation_id=conversation_id,
                    model=parsed.model,
                    input_tokens=parsed.input_tokens,
                    output_tokens=parsed.output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    success=True,
                    metadata=parsed.metadata,
                )
                _global_tracker.call_logs.append(log_entry)

                return response

            except Exception as exc:
                latency_ms = int((time.time() - start_time) * 1000)

                log_entry = build_memory_log_entry(
                    call_id=call_id,
                    endpoint=endpoint_name,
                    conversation_id=conversation_id,
                    model="unknown",
                    input_tokens=0,
                    output_tokens=0,
                    total_tokens=0,
                    cost_usd=0.0,
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    success=False,
                    error_message=str(exc),
                )
                _global_tracker.call_logs.append(log_entry)

                raise

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator
