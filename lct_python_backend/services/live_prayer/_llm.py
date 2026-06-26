"""LLM access for the live-prayer path.

Uses the same provider list as the Settings-controlled LLM config so that the
Settings UI is the single control plane for provider order and fallback. In normal
operation the WS session passes its ``_runtime_llm_providers`` (DB-loaded) directly
through the runner; ``local_providers()`` is only the last-resort fallback for tests
or when the feature flag is off.

Local-only privacy contract: the live-prayer path sends transcript text verbatim, which
is safe because all providers in the configured list are on owner-controlled infra
(Tailscale CGNAT is allow-listed by the egress guard). Do not add cloud providers to
the llm_providers Settings list without also adding a redaction step here.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger("lct_backend")


def local_providers() -> List[Dict[str, Any]]:
    """Fallback provider list (used only when the WS session passes no providers).
    Returns ``get_default_providers()`` so Settings drives the LLM fallback order."""
    from lct_python_backend.services.llm_config import get_default_providers
    return get_default_providers()


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
