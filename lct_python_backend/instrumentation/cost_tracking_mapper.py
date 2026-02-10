"""
Mapping helpers for instrumentation log entries.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Type
import uuid

from .cost_calculator import calculate_cost_breakdown


def parse_uuid_or_none(value: Optional[Any]) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def infer_provider_from_model(model: str) -> str:
    normalized = (model or "").strip().lower()
    if not normalized:
        return "unknown"
    if normalized.startswith(("gpt", "o1", "o3")) or "openai" in normalized:
        return "openai"
    if "claude" in normalized or "anthropic" in normalized:
        return "anthropic"
    if "gemini" in normalized or "google" in normalized:
        return "google"
    if normalized.startswith(("local-", "lm-studio", "ollama")):
        return "local"
    return "unknown"


def build_memory_log_entry(
    *,
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
) -> Dict[str, Any]:
    return {
        "id": call_id,
        "endpoint": endpoint,
        "conversation_id": conversation_id,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
        "latency_ms": latency_ms,
        "timestamp": timestamp,
        "success": success,
        "error_message": error_message,
        "metadata": metadata or {},
    }


def build_api_calls_log_record(
    *,
    api_calls_log_cls: Type[Any],
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
) -> Any:
    prompt_cost = 0.0
    completion_cost = 0.0
    total_cost = float(cost_usd or 0.0)

    if model and (input_tokens > 0 or output_tokens > 0):
        try:
            prompt_cost, completion_cost, computed_total = calculate_cost_breakdown(
                model,
                input_tokens,
                output_tokens,
            )
            if total_cost == 0.0:
                total_cost = float(computed_total)
        except ValueError:
            # Unknown model pricing should not block persistence.
            pass

    ts = timestamp if timestamp.tzinfo else timestamp.replace(tzinfo=timezone.utc)
    call_uuid = parse_uuid_or_none(call_id) or uuid.uuid4()
    conv_uuid = parse_uuid_or_none(conversation_id)
    metadata_payload = metadata or {}

    return api_calls_log_cls(
        id=call_uuid,
        conversation_id=conv_uuid,
        endpoint=endpoint,
        feature=str(metadata_payload.get("feature") or endpoint),
        provider=str(metadata_payload.get("provider") or infer_provider_from_model(model)),
        model=model or "unknown",
        prompt_tokens=int(input_tokens or 0),
        completion_tokens=int(output_tokens or 0),
        total_tokens=int(total_tokens or 0),
        prompt_cost=float(prompt_cost),
        completion_cost=float(completion_cost),
        total_cost=float(total_cost),
        latency_ms=int(latency_ms or 0),
        status="success" if success else "error",
        error_message=error_message,
        started_at=ts,
        completed_at=ts + timedelta(milliseconds=max(int(latency_ms or 0), 0)),
        request_id=(
            str(metadata_payload.get("request_id"))
            if metadata_payload.get("request_id") is not None
            else None
        ),
    )
