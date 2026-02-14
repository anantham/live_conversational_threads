import os
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

LLM_CONFIG_KEY = "llm_config"
TAILSCALE_LLM_BASE_URL = "http://100.81.65.74:1234"


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    value_str = str(value).strip().lower()
    return value_str in {"1", "true", "yes", "on"}


def get_env_llm_defaults() -> Dict[str, Any]:
    return {
        "mode": os.getenv("DEFAULT_LLM_MODE", "local"),
        "base_url": os.getenv("LOCAL_LLM_BASE_URL", TAILSCALE_LLM_BASE_URL),
        "chat_model": os.getenv("LOCAL_LLM_CHAT_MODEL", "glm-4.6v-flash"),
        "embedding_model": os.getenv("LOCAL_LLM_EMBEDDING_MODEL", "text-embedding-qwen3-embedding-8b"),
        "json_mode": _to_bool(os.getenv("LOCAL_LLM_JSON_MODE", "true")),
        "timeout_seconds": float(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "120")),
    }


def merge_llm_config(overrides: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    config = get_env_llm_defaults()
    if not overrides:
        return config

    sanitized = {}
    for key, value in overrides.items():
        if key in {"json_mode"}:
            sanitized[key] = _to_bool(value)
        elif key == "mode":
            normalized = str(value).strip().lower()
            sanitized[key] = normalized if normalized in {"local", "online"} else config["mode"]
        else:
            sanitized[key] = value

    config.update(sanitized)

    # Older local configs often point to localhost:1234; default to the Tailscale
    # endpoint for this repo unless explicitly changed away from the localhost LM Studio port.
    base_url = str(config.get("base_url", "")).strip()
    if base_url.startswith("http://localhost:1234") or base_url.startswith("http://127.0.0.1:1234"):
        config["base_url"] = os.getenv("LOCAL_LLM_BASE_URL", TAILSCALE_LLM_BASE_URL)

    return config


async def load_llm_config(session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    config = get_env_llm_defaults()
    if session is None:
        return config

    try:
        from lct_python_backend.models import AppSetting
    except Exception:
        return config

    result = await session.execute(
        select(AppSetting).where(AppSetting.key == LLM_CONFIG_KEY)
    )
    setting = result.scalar_one_or_none()
    overrides = setting.value if setting else {}
    return merge_llm_config(overrides)
