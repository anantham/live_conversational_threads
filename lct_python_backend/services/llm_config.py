import os
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

LLM_CONFIG_KEY = "llm_config"
LLM_PROVIDERS_KEY = "llm_providers"
TAILSCALE_LLM_BASE_URL = "http://100.81.65.74:1234"


# ── Default provider definitions ────────────────────────────────────────────

def get_default_providers() -> List[Dict[str, Any]]:
    """Return default LLM provider list with priority order."""
    return [
        {
            "id": "local_lmstudio",
            "name": "Local LM Studio",
            "type": "openai_compatible",
            "base_url": os.getenv("LMSTUDIO_BASE_URL", TAILSCALE_LLM_BASE_URL),
            "model": os.getenv("LOCAL_LLM_CHAT_MODEL", "qwen3-32b"),
            "api_key": None,
            "enabled": True,
            "timeout_seconds": 120,
        },
        {
            "id": "modal_qwen",
            "name": "Modal Qwen3-32B",
            "type": "openai_compatible",
            "base_url": os.getenv("MODAL_LLM_URL", "https://adityaarpitha--llm-server-serve.modal.run"),
            "model": "qwen3-32b",
            "api_key": None,
            "enabled": True,
            "timeout_seconds": 180,
        },
        {
            "id": "openrouter_gemini",
            "name": "OpenRouter Gemini 3 Flash",
            "type": "openrouter",
            "base_url": "https://openrouter.ai/api/v1",
            "model": "google/gemini-3-flash-preview",
            "api_key": os.getenv("OPENROUTER_API_KEY", ""),
            "enabled": bool(os.getenv("OPENROUTER_API_KEY")),
            "timeout_seconds": 60,
        },
    ]


def get_env_providers_defaults() -> Dict[str, Any]:
    """Return default provider settings from environment."""
    return {
        "providers": get_default_providers(),
        "embedding_provider_id": "local_lmstudio",
        "json_mode": _to_bool(os.getenv("LOCAL_LLM_JSON_MODE", "true")),
    }


async def load_llm_providers(session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    """Load LLM provider settings from DB, merged with env defaults."""
    defaults = get_env_providers_defaults()
    if session is None:
        return defaults

    try:
        from lct_python_backend.models import AppSetting
    except Exception:
        return defaults

    result = await session.execute(
        select(AppSetting).where(AppSetting.key == LLM_PROVIDERS_KEY)
    )
    setting = result.scalar_one_or_none()
    if not setting:
        return defaults

    # Merge DB overrides with defaults
    stored = setting.value or {}
    merged = {**defaults, **stored}

    # Ensure providers list has required fields
    if "providers" in merged and isinstance(merged["providers"], list):
        for provider in merged["providers"]:
            if "enabled" not in provider:
                provider["enabled"] = True
            if "timeout_seconds" not in provider:
                provider["timeout_seconds"] = 120

    return merged


async def save_llm_providers(session: AsyncSession, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Persist LLM provider settings and return merged config."""
    from datetime import datetime
    from lct_python_backend.models import AppSetting

    stmt = select(AppSetting).where(AppSetting.key == LLM_PROVIDERS_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing:
        existing.value = payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=LLM_PROVIDERS_KEY, value=payload))
    await session.commit()
    return await load_llm_providers(session)


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    value_str = str(value).strip().lower()
    return value_str in {"1", "true", "yes", "on"}


def get_env_llm_defaults() -> Dict[str, Any]:
    return {
        "mode": os.getenv("DEFAULT_LLM_MODE", "local"),
        "base_url": os.getenv("LOCAL_LLM_BASE_URL", TAILSCALE_LLM_BASE_URL),
        "chat_model": os.getenv("LOCAL_LLM_CHAT_MODEL", "zai-org/glm-4.6v-flash"),
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
