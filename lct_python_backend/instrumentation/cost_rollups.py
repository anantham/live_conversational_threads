"""
Pure rollup helpers for instrumentation cost data.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable


@dataclass
class CostAggregation:
    """Aggregated cost data for a time period."""

    period_start: datetime
    period_end: datetime
    total_cost: float
    total_tokens: int
    total_calls: int
    cost_by_model: Dict[str, float]
    cost_by_endpoint: Dict[str, float]
    calls_by_model: Dict[str, int]
    calls_by_endpoint: Dict[str, int]
    tokens_by_model: Dict[str, int]
    avg_cost_per_call: float
    avg_tokens_per_call: float


@dataclass
class ConversationCost:
    """Cost breakdown for a single conversation."""

    conversation_id: str
    total_cost: float
    total_tokens: int
    total_calls: int
    cost_by_endpoint: Dict[str, float]
    cost_by_model: Dict[str, float]
    first_call: datetime
    last_call: datetime


def empty_cost_aggregation(period_start: datetime, period_end: datetime) -> CostAggregation:
    return CostAggregation(
        period_start=period_start,
        period_end=period_end,
        total_cost=0.0,
        total_tokens=0,
        total_calls=0,
        cost_by_model={},
        cost_by_endpoint={},
        calls_by_model={},
        calls_by_endpoint={},
        tokens_by_model={},
        avg_cost_per_call=0.0,
        avg_tokens_per_call=0.0,
    )


def rollup_cost_logs(
    *,
    period_start: datetime,
    period_end: datetime,
    logs: Iterable[Any],
) -> CostAggregation:
    logs_list = list(logs)
    if not logs_list:
        return empty_cost_aggregation(period_start, period_end)

    total_cost = 0.0
    total_tokens = 0
    total_calls = len(logs_list)

    cost_by_model = defaultdict(float)
    cost_by_endpoint = defaultdict(float)
    calls_by_model = defaultdict(int)
    calls_by_endpoint = defaultdict(int)
    tokens_by_model = defaultdict(int)

    for log in logs_list:
        model = str(getattr(log, "model", "unknown") or "unknown")
        endpoint = str(getattr(log, "endpoint", "unknown") or "unknown")
        call_cost = float(getattr(log, "total_cost", 0.0) or 0.0)
        call_tokens = int(getattr(log, "total_tokens", 0) or 0)

        total_cost += call_cost
        total_tokens += call_tokens

        cost_by_model[model] += call_cost
        cost_by_endpoint[endpoint] += call_cost
        calls_by_model[model] += 1
        calls_by_endpoint[endpoint] += 1
        tokens_by_model[model] += call_tokens

    avg_cost_per_call = total_cost / total_calls if total_calls > 0 else 0.0
    avg_tokens_per_call = total_tokens / total_calls if total_calls > 0 else 0.0

    return CostAggregation(
        period_start=period_start,
        period_end=period_end,
        total_cost=total_cost,
        total_tokens=total_tokens,
        total_calls=total_calls,
        cost_by_model=dict(cost_by_model),
        cost_by_endpoint=dict(cost_by_endpoint),
        calls_by_model=dict(calls_by_model),
        calls_by_endpoint=dict(calls_by_endpoint),
        tokens_by_model=dict(tokens_by_model),
        avg_cost_per_call=avg_cost_per_call,
        avg_tokens_per_call=avg_tokens_per_call,
    )


def rollup_conversation_cost(
    *,
    conversation_id: str,
    logs: Iterable[Any],
) -> ConversationCost:
    logs_list = list(logs)
    if not logs_list:
        raise ValueError(f"No API calls found for conversation {conversation_id}")

    total_cost = 0.0
    total_tokens = 0
    total_calls = len(logs_list)
    cost_by_endpoint = defaultdict(float)
    cost_by_model = defaultdict(float)

    first_call = logs_list[0].started_at
    last_call = logs_list[-1].started_at

    for log in logs_list:
        model = str(getattr(log, "model", "unknown") or "unknown")
        endpoint = str(getattr(log, "endpoint", "unknown") or "unknown")
        call_cost = float(getattr(log, "total_cost", 0.0) or 0.0)
        call_tokens = int(getattr(log, "total_tokens", 0) or 0)

        total_cost += call_cost
        total_tokens += call_tokens
        cost_by_endpoint[endpoint] += call_cost
        cost_by_model[model] += call_cost

    return ConversationCost(
        conversation_id=conversation_id,
        total_cost=total_cost,
        total_tokens=total_tokens,
        total_calls=total_calls,
        cost_by_endpoint=dict(cost_by_endpoint),
        cost_by_model=dict(cost_by_model),
        first_call=first_call,
        last_call=last_call,
    )
