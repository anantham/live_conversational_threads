"""Shared type coercion helpers.

Centralizes boolean, string, numeric, and URL coercion logic that was
previously duplicated across stt_config, llm_config, transcription_utils,
stt_live_provider_selection, and other modules.

Domain-specific normalization (provider IDs, transcript structures, etc.)
stays in its respective module.
"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Boolean
# ---------------------------------------------------------------------------

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


def to_bool(value: Any, default: bool = False) -> bool:
    """Coerce *value* to bool.

    Accepts bool, truthy/falsy strings (``"1"``, ``"true"``, ``"yes"``,
    ``"on"`` and their negations), and falls back to *default* for empty
    or unrecognised values.
    """
    if isinstance(value, bool):
        return value
    raw = str(value or "").strip().lower()
    if not raw:
        return default
    if raw in _TRUTHY:
        return True
    if raw in _FALSY:
        return False
    return default


# ---------------------------------------------------------------------------
# String
# ---------------------------------------------------------------------------


def coerce_str(value: Any) -> str:
    """Coerce *value* to a stripped string.  ``None`` → ``""``."""
    if value is None:
        return ""
    return str(value).strip()


# ---------------------------------------------------------------------------
# Numeric
# ---------------------------------------------------------------------------


def coerce_float(value: Any) -> Optional[float]:
    """Coerce *value* to float, returning ``None`` on failure."""
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def coerce_int(value: Any) -> Optional[int]:
    """Coerce *value* to int, returning ``None`` on failure."""
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce *value* to float with a guaranteed numeric return."""
    result = coerce_float(value)
    return result if result is not None else default


def safe_int(value: Any, default: int = 0) -> int:
    """Coerce *value* to int with a guaranteed numeric return."""
    result = coerce_int(value)
    return result if result is not None else default


# ---------------------------------------------------------------------------
# URL
# ---------------------------------------------------------------------------


def coerce_url(value: Any) -> str:
    """Coerce *value* to a cleaned URL string.

    Strips whitespace and trailing slashes.  Returns ``""`` for
    ``None`` or empty input.
    """
    raw = coerce_str(value)
    return raw.rstrip("/") if raw else ""
