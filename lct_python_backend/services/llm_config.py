import os
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, urlunparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.coercion_helpers import to_bool, coerce_str, coerce_url, safe_int

LLM_CONFIG_KEY = "llm_config"
LLM_PROVIDERS_KEY = "llm_providers"
TAILSCALE_LLM_BASE_URL = "http://100.81.65.74:1234"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api"
LLM_PROVIDER_TYPES = ("openai_compatible", "openai", "openrouter")


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
            "base_url": DEFAULT_OPENROUTER_BASE_URL,
            "model": "google/gemini-3-flash-preview",
            "api_key": os.getenv("OPENROUTER_API_KEY", ""),
            "enabled": bool(os.getenv("OPENROUTER_API_KEY")),
            "timeout_seconds": 60,
        },
    ]


def get_env_providers_defaults() -> Dict[str, Any]:
    """Return default provider settings from environment.

    The ``embedding_provider_id`` field that lived here historically was
    never consumed. ADR-030 §B4 removed it; embeddings now route through
    ``services.llm_gateway`` with strict model-fidelity matching.
    """
    return {
        "providers": get_default_providers(),
        "json_mode": to_bool(os.getenv("LOCAL_LLM_JSON_MODE", "true")),
    }


def _normalize_provider_type(value: Any) -> str:
    provider_type = str(value or "openai_compatible").strip().lower()
    return provider_type if provider_type in LLM_PROVIDER_TYPES else "openai_compatible"


def _strip_provider_endpoint_suffix(path: str) -> str:
    normalized = str(path or "").rstrip("/")
    for suffix in (
        "/v1/chat/completions",
        "/chat/completions",
        "/v1/embeddings",
        "/embeddings",
        "/v1/models",
        "/models",
        "/health",
    ):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
            break
    return normalized.rstrip("/")


def normalize_provider_base_url(provider_type: Any, base_url: Any) -> str:
    coerced = coerce_url(base_url)
    if not coerced:
        return ""

    # Ensure a scheme is present so urlparse can split netloc/path correctly.
    if "://" not in coerced:
        coerced = f"https://{coerced}"

    parsed = urlparse(coerced)
    path = _strip_provider_endpoint_suffix(parsed.path)
    normalized_type = _normalize_provider_type(provider_type)

    if normalized_type == "openrouter":
        if path.endswith("/api/v1"):
            path = path[: -len("/v1")]
        elif path in {"", "/"} and parsed.netloc.lower() == "openrouter.ai":
            path = "/api"
    else:
        if path.endswith("/v1"):
            path = path[: -len("/v1")]

    if normalized_type == "openai" and parsed.netloc.lower() == "api.openai.com" and not path:
        path = ""
    if normalized_type == "openrouter" and parsed.netloc.lower() == "openrouter.ai" and not path:
        path = "/api"

    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", "")).rstrip("/")


def build_provider_api_url(base_url: Any, provider_type: Any, resource: str) -> str:
    normalized_base_url = normalize_provider_base_url(provider_type, base_url)
    if not normalized_base_url:
        return ""
    normalized_resource = str(resource or "").strip().lstrip("/")
    if not normalized_resource:
        return normalized_base_url
    return f"{normalized_base_url}/v1/{normalized_resource}"


def _sanitize_provider_for_client(provider: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(provider)
    api_key = str(sanitized.pop("api_key", "") or "").strip()
    sanitized["api_key"] = ""
    sanitized["has_api_key"] = bool(api_key)
    sanitized["type"] = _normalize_provider_type(sanitized.get("type"))
    sanitized["base_url"] = normalize_provider_base_url(sanitized.get("type"), sanitized.get("base_url"))
    return sanitized


def normalize_provider_record(
    raw_provider: Dict[str, Any],
    existing_provider: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    existing = existing_provider or {}
    provider_type = _normalize_provider_type(raw_provider.get("type", existing.get("type")))
    provider_id = str(raw_provider.get("id") or existing.get("id") or "").strip()
    provider_name = str(raw_provider.get("name") or existing.get("name") or provider_id).strip()
    base_url = normalize_provider_base_url(
        provider_type,
        raw_provider.get("base_url", existing.get("base_url")),
    )
    model = str(raw_provider.get("model") or existing.get("model") or "").strip()
    provider: Dict[str, Any] = {
        "id": provider_id,
        "name": provider_name,
        "type": provider_type,
        "base_url": base_url,
        "model": model,
        "enabled": to_bool(raw_provider.get("enabled", existing.get("enabled", True))),
        "timeout_seconds": max(1, safe_int(
            raw_provider.get("timeout_seconds", existing.get("timeout_seconds", 120)),
            120,
        )),
    }

    clear_api_key = to_bool(raw_provider.get("clear_api_key", False))
    incoming_api_key = raw_provider.get("api_key")
    if clear_api_key:
        provider["api_key"] = ""
    elif incoming_api_key is not None:
        provider["api_key"] = str(incoming_api_key).strip()
    elif "api_key" in existing:
        provider["api_key"] = existing.get("api_key", "")

    return provider


def _merge_provider_list(
    raw_providers: Any,
    default_providers: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    defaults_by_id = {
        str(provider.get("id") or "").strip(): normalize_provider_record(provider)
        for provider in default_providers
    }

    if not isinstance(raw_providers, list):
        return [dict(provider) for provider in defaults_by_id.values()]

    merged: List[Dict[str, Any]] = []
    for raw_provider in raw_providers:
        if not isinstance(raw_provider, dict):
            continue
        provider_id = str(raw_provider.get("id") or "").strip()
        existing = defaults_by_id.get(provider_id)
        merged.append(normalize_provider_record(raw_provider, existing))
    return merged


def _sanitize_provider_config_for_client(config: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(config)
    providers = sanitized.get("providers")
    if isinstance(providers, list):
        sanitized["providers"] = [_sanitize_provider_for_client(provider) for provider in providers]
    return sanitized


async def load_llm_providers(
    session: Optional[AsyncSession] = None,
    include_secrets: bool = False,
) -> Dict[str, Any]:
    """Load LLM provider settings from DB, merged with env defaults."""
    defaults = get_env_providers_defaults()
    defaults["providers"] = _merge_provider_list(defaults.get("providers"), [])
    if session is None:
        return defaults if include_secrets else _sanitize_provider_config_for_client(defaults)

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

    stored = setting.value or {}
    merged = {**defaults, **stored}
    merged["providers"] = _merge_provider_list(stored.get("providers"), defaults.get("providers", []))
    return merged if include_secrets else _sanitize_provider_config_for_client(merged)


async def save_llm_providers(session: AsyncSession, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Persist LLM provider settings and return merged config."""
    from datetime import datetime
    from lct_python_backend.models import AppSetting

    stmt = select(AppSetting).where(AppSetting.key == LLM_PROVIDERS_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    existing_value = existing.value if existing and isinstance(existing.value, dict) else {}
    existing_providers = existing_value.get("providers")
    existing_by_id = {}
    if isinstance(existing_providers, list):
        for provider in existing_providers:
            if isinstance(provider, dict):
                provider_id = str(provider.get("id") or "").strip()
                if provider_id:
                    existing_by_id[provider_id] = provider

    providers = payload.get("providers") if isinstance(payload.get("providers"), list) else []
    normalized_providers = []
    for raw_provider in providers:
        if not isinstance(raw_provider, dict):
            continue
        provider_for_save = dict(raw_provider)
        if (
            provider_for_save.get("api_key") is not None
            and not str(provider_for_save.get("api_key") or "").strip()
            and not to_bool(provider_for_save.get("clear_api_key", False))
        ):
            provider_for_save.pop("api_key", None)
        provider_id = str(raw_provider.get("id") or "").strip()
        normalized_providers.append(
            normalize_provider_record(provider_for_save, existing_by_id.get(provider_id))
        )

    normalized_payload = {
        "providers": normalized_providers,
        "json_mode": to_bool(
            payload.get("json_mode", existing_value.get("json_mode", os.getenv("LOCAL_LLM_JSON_MODE", "true")))
        ),
    }

    if existing:
        existing.value = normalized_payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=LLM_PROVIDERS_KEY, value=normalized_payload))
    await session.commit()
    return await load_llm_providers(session, include_secrets=False)


def get_env_llm_defaults() -> Dict[str, Any]:
    return {
        "mode": os.getenv("DEFAULT_LLM_MODE", "local"),
        "base_url": os.getenv("LOCAL_LLM_BASE_URL", TAILSCALE_LLM_BASE_URL),
        "chat_model": os.getenv("LOCAL_LLM_CHAT_MODEL", "zai-org/glm-4.6v-flash"),
        "embedding_model": os.getenv("LOCAL_LLM_EMBEDDING_MODEL", "text-embedding-qwen3-embedding-8b"),
        "json_mode": to_bool(os.getenv("LOCAL_LLM_JSON_MODE", "true")),
        "timeout_seconds": float(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "120")),
    }


def merge_llm_config(overrides: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    config = get_env_llm_defaults()
    if not overrides:
        return config

    sanitized = {}
    for key, value in overrides.items():
        if key in {"json_mode"}:
            sanitized[key] = to_bool(value)
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
