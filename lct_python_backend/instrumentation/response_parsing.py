"""
Helpers for extracting usage metrics from LLM provider responses.
"""

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Tuple


@dataclass(frozen=True)
class ParsedResponseMetrics:
    """Normalized usage fields extracted from a provider response."""

    model: str
    input_tokens: int
    output_tokens: int
    metadata: Dict[str, Any]


def _to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_usage_tokens(usage: Any) -> Tuple[int, int]:
    if usage is None:
        return 0, 0

    if isinstance(usage, Mapping):
        prompt_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
        completion_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0))
        return _to_int(prompt_tokens), _to_int(completion_tokens)

    prompt_tokens = getattr(usage, "prompt_tokens", getattr(usage, "input_tokens", 0))
    completion_tokens = getattr(usage, "completion_tokens", getattr(usage, "output_tokens", 0))
    return _to_int(prompt_tokens), _to_int(completion_tokens)


def _extract_finish_reason(response: Any) -> Any:
    choices = None
    if isinstance(response, Mapping):
        choices = response.get("choices")
    else:
        choices = getattr(response, "choices", None)

    if not isinstance(choices, (list, tuple)) or len(choices) == 0:
        return None

    first_choice = choices[0]
    if isinstance(first_choice, Mapping):
        return first_choice.get("finish_reason")
    return getattr(first_choice, "finish_reason", None)


def parse_response_metrics(response: Any) -> ParsedResponseMetrics:
    """
    Parse model/token metadata from object-based or dict-based responses.
    """

    if isinstance(response, Mapping):
        model = str(response.get("model") or "unknown")
        usage = response.get("usage", {})
    else:
        model = str(getattr(response, "model", "unknown") or "unknown")
        usage = getattr(response, "usage", None)

    input_tokens, output_tokens = _extract_usage_tokens(usage)

    metadata: Dict[str, Any] = {}
    finish_reason = _extract_finish_reason(response)
    if finish_reason is not None:
        metadata["finish_reason"] = finish_reason

    return ParsedResponseMetrics(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        metadata=metadata,
    )
