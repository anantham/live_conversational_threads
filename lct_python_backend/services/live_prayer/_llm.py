"""Local M5 LLM access for the live-prayer path.

Deliberately pins the M5 Tailscale box (env-overridable), NOT the generic
``get_default_providers()`` — this box's local LM Studio is embedding-pinned, so
big-prompt LLM work routes to the shared M5 (see memory: local-gpu-embedding-pinned).
Local-only: M5 is on the owner's own infra (Tailscale CGNAT is allow-listed by the
egress guard), so the live-prayer path sends transcript text verbatim, no redaction.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

from lct_python_backend.services.env_helpers import env_float, env_str

logger = logging.getLogger("lct_backend")

_BASE_URL = env_str("LIVE_PRAYER_LLM_BASE_URL", "http://100.83.228.35:11434")
_MODEL = env_str("LIVE_PRAYER_LLM_MODEL", "gemma4:latest")
_TIMEOUT_S = env_float("LIVE_PRAYER_LLM_TIMEOUT_SECONDS", 30.0)


def local_providers() -> List[Dict[str, Any]]:
    """One provider dict pointing at the M5 (or env-configured) local LLM."""
    return [{
        "id": "live-prayer-m5",
        "name": f"live-prayer ({_MODEL})",
        "type": "openai_compatible",
        "base_url": _BASE_URL,
        "model": _MODEL,
        "api_key": None,
        "enabled": True,
        "timeout_seconds": _TIMEOUT_S,
    }]


def _coerce_json(data: Any) -> Dict[str, Any]:
    """Best-effort JSON dict from an LLM response (dict passthrough or parse str)."""
    if isinstance(data, dict):
        return data
    s = (data or "") if isinstance(data, str) else ""
    if "```" in s:
        m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
        if m:
            s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        s = s[i:j + 1]
    try:
        out = json.loads(s)
        return out if isinstance(out, dict) else {}
    except (ValueError, TypeError):
        return {}


async def call_json(
    prompt: str,
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
    max_tokens: int = 512,
    temperature: float = 0.1,
) -> Dict[str, Any]:
    """Call the local LLM for a JSON object. Returns {} on any failure (caller
    decides what an empty result means — typically 'no trigger' / 'unverifiable')."""
    from lct_python_backend.services.local_llm_client import chat_with_provider_fallback
    try:
        result = await chat_with_provider_fallback(
            [{"role": "user", "content": prompt}],
            providers=providers or local_providers(),
            require_json=True,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    except Exception as exc:  # noqa: BLE001 — live path must never raise
        logger.warning("[live-prayer] local LLM call failed: %s", type(exc).__name__)
        return {}
    return _coerce_json(result.data)
