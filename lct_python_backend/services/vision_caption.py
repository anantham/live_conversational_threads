"""
Image captioning via the shared M5 Tailscale Ollama (see synthesis_engine.py
for the same box/URL convention). Used by the WhatsApp zip import to turn an
inline image attachment into a short text caption spliced into the transcript.

Requires a VISION-CAPABLE model tag to actually be pulled on M5's Ollama —
``WHATSAPP_VISION_MODEL`` below is a placeholder default; verify/pull the
right tag before relying on this in production.
"""

from __future__ import annotations

import base64
import logging
from typing import Any, Dict, List, Optional

from lct_python_backend.services.env_helpers import env_float, env_str

logger = logging.getLogger(__name__)

# Reuse the same M5 box synthesis_engine.py already points at.
_VISION_BASE_URL = env_str("SYNTHESIS_LOCAL_BASE_URL", "http://100.83.228.35:11434")
# gemma4:latest (the synthesis default) confirmed vision-capable via
# POST /api/show on M5's Ollama (capabilities include "vision") — separate
# env knob from SYNTHESIS_LOCAL_MODEL in case that default ever changes to a
# text-only model.
_VISION_MODEL = env_str("WHATSAPP_VISION_MODEL", "gemma4:latest")
_VISION_TIMEOUT_S = env_float("WHATSAPP_VISION_TIMEOUT_SECONDS", 120.0)

CAPTION_PROMPT = (
    "Describe this image in 1-2 concise sentences, as an inline caption for "
    "a chat conversation transcript. Describe only what's visible; do not "
    "speculate about context you can't see."
)


def _vision_providers() -> List[Dict[str, Any]]:
    return [{
        "id": "whatsapp-vision",
        "name": f"whatsapp vision ({_VISION_MODEL})",
        "type": "openai_compatible",
        "base_url": _VISION_BASE_URL,
        "model": _VISION_MODEL,
        "api_key": None,
        "enabled": True,
        "timeout_seconds": _VISION_TIMEOUT_S,
    }]


def _stringify(data: Any) -> str:
    if isinstance(data, str):
        return data
    import json
    return json.dumps(data, ensure_ascii=False)


async def caption_image(
    image_bytes: bytes,
    *,
    mime_type: str,
    filename: str = "image",
    providers: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Caption an image via the M5 vision model. Never raises — on any
    failure (timeout, unreachable model, bad response) logs a warning and
    returns a placeholder so one bad image can't fail a whole import."""
    from lct_python_backend.services.local_llm_client import chat_with_provider_fallback

    b64 = base64.b64encode(image_bytes).decode("ascii")
    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": CAPTION_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
        ],
    }]

    try:
        result = await chat_with_provider_fallback(
            messages,
            providers=providers or _vision_providers(),
            require_json=False,
        )
        caption = _stringify(result.data).strip()
        if not caption:
            raise ValueError("empty caption returned")
        return caption
    except Exception as exc:  # noqa: BLE001 — captioning is best-effort
        logger.warning("Vision caption failed for %s: %r", filename, exc)
        return f"{filename} — captioning unavailable"
