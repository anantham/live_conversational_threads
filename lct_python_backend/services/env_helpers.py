"""Typed environment-variable readers.

Replaces the ``str(os.getenv("X", "y")).strip() or "y"`` and
``os.getenv("X", "false").strip().lower() in {"1","true","yes","on"}``
boilerplate that recurs in 30+ places. Each helper:

  * strips whitespace,
  * treats an empty (after strip) value as "use default",
  * coerces to the declared type, or returns the default on parse failure.

Designed for module-import-time reads (no caching needed). For
DB-backed runtime settings, use ``settings_service`` instead.
"""

from __future__ import annotations

import os
from typing import Optional


_TRUE_VALUES: frozenset[str] = frozenset({"1", "true", "yes", "on", "y", "t"})
_FALSE_VALUES: frozenset[str] = frozenset({"0", "false", "no", "off", "n", "f", ""})


def env_str(name: str, default: str = "") -> str:
    """Return env[name] stripped, falling back to *default* when empty."""
    raw = os.getenv(name)
    if raw is None:
        return default
    stripped = raw.strip()
    return stripped if stripped else default


def env_bool(name: str, default: bool = False) -> bool:
    """Parse env[name] as a boolean. Unrecognized → *default*."""
    raw = os.getenv(name)
    if raw is None:
        return default
    stripped = raw.strip().lower()
    if stripped in _TRUE_VALUES:
        return True
    if stripped in _FALSE_VALUES:
        return False
    return default


def env_int(name: str, default: int) -> int:
    """Parse env[name] as int. Empty / unparseable → *default*."""
    raw = os.getenv(name)
    if raw is None:
        return default
    stripped = raw.strip()
    if not stripped:
        return default
    try:
        return int(stripped)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    """Parse env[name] as float. Empty / unparseable → *default*."""
    raw = os.getenv(name)
    if raw is None:
        return default
    stripped = raw.strip()
    if not stripped:
        return default
    try:
        return float(stripped)
    except ValueError:
        return default


def env_str_or_none(name: str) -> Optional[str]:
    """Like env_str but returns None instead of an empty string."""
    raw = os.getenv(name)
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped if stripped else None
