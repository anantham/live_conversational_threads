import os
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
import httpx
from sqlalchemy import select

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import AppSetting
from lct_python_backend.services.llm_config import (
    LLM_CONFIG_KEY,
    build_provider_api_url,
    merge_llm_config,
    load_llm_providers,
    normalize_provider_record,
    save_llm_providers,
)

router = APIRouter()


ONLINE_GEMINI_FALLBACK_MODELS = [
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]

LOCAL_CHAT_FALLBACK_MODELS = [
    "zai-org/glm-4.6v-flash",
    "reka-flash-3-21b-reasoning-uncensored-max-neo-imatrix",
    "qwen/qwen3-coder-30b",
    "qwen/qwen3-vl-8b",
    "liquid/lfm2.5-1.2b",
]

MODEL_OPTIONS_CACHE_TTL_SECONDS = 300
_MODEL_OPTIONS_CACHE: Dict[str, Dict[str, Any]] = {}


def _resolve_gemini_api_key() -> Tuple[str, str]:
    for env_name in ("GOOGLEAI_API_KEY", "GEMINI_API_KEY", "GEMINI_KEY"):
        value = str(os.getenv(env_name, "")).strip()
        if value:
            return value, env_name
    return "", ""


def _normalize_model_name(model_name: Any) -> str:
    normalized = str(model_name or "").strip()
    if normalized.startswith("models/"):
        normalized = normalized[len("models/") :]
    if "/" in normalized and "gemini" in normalized.lower():
        tail = normalized.split("/")[-1]
        if "gemini" in tail.lower():
            normalized = tail
    return normalized


def _cache_get(cache_key: str) -> Optional[List[str]]:
    cached = _MODEL_OPTIONS_CACHE.get(cache_key)
    if not cached:
        return None
    if time.time() - float(cached.get("ts", 0)) > MODEL_OPTIONS_CACHE_TTL_SECONDS:
        _MODEL_OPTIONS_CACHE.pop(cache_key, None)
        return None
    models = cached.get("models")
    if not isinstance(models, list):
        return None
    return models


def _cache_set(cache_key: str, models: List[str]) -> None:
    _MODEL_OPTIONS_CACHE[cache_key] = {"ts": time.time(), "models": models}


async def _fetch_online_gemini_models() -> List[str]:
    key, _source = _resolve_gemini_api_key()
    if not key:
        return []

    cache_key = "online:gemini"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    models: Set[str] = set()
    page_token: Optional[str] = None
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models"

    async with httpx.AsyncClient(timeout=10.0) as client:
        for _ in range(3):
            params: Dict[str, Any] = {"key": key, "pageSize": 1000}
            if page_token:
                params["pageToken"] = page_token

            response = await client.get(endpoint, params=params)
            response.raise_for_status()
            payload = response.json() if response.content else {}
            for model in payload.get("models", []):
                raw_name = model.get("name")
                normalized = _normalize_model_name(raw_name)
                if not normalized or "gemini" not in normalized.lower():
                    continue
                methods = model.get("supportedGenerationMethods") or []
                if "generateContent" not in methods:
                    continue
                models.add(normalized)

            page_token = payload.get("nextPageToken")
            if not page_token:
                break

    resolved = sorted(models)
    if resolved:
        _cache_set(cache_key, resolved)
    return resolved


async def _fetch_local_models(base_url: str) -> List[str]:
    normalized_base_url = str(base_url or "").strip().rstrip("/")
    if not normalized_base_url:
        return []

    cache_key = f"local:{normalized_base_url}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    endpoint = f"{normalized_base_url}/v1/models"
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(endpoint)
        response.raise_for_status()
        payload = response.json() if response.content else {}

    models = payload.get("data")
    if not isinstance(models, list):
        return []

    ids = sorted({str(item.get("id", "")).strip() for item in models if isinstance(item, dict) and str(item.get("id", "")).strip()})
    if ids:
        _cache_set(cache_key, ids)
    return ids


def _normalize_mode(raw_mode: Any) -> str:
    mode = str(raw_mode or "local").strip().lower()
    return mode if mode in {"local", "online"} else "local"


@router.get("/api/settings/llm")
async def read_llm_settings(session=Depends(get_async_session)):
    result = await session.execute(
        select(AppSetting).where(AppSetting.key == LLM_CONFIG_KEY)
    )
    setting = result.scalar_one_or_none()
    overrides = setting.value if setting else {}
    return merge_llm_config(overrides)


@router.get("/api/settings/llm/telemetry")
async def read_llm_telemetry(
    limit: int = 400,
    session=Depends(get_async_session),
):
    """Per-provider live LLM speed telemetry (tokens/sec, total ms, samples).

    Mirrors GET /api/settings/stt/telemetry. Backed by the append-only LLM
    telemetry log, so numbers persist across restarts ("keep collecting").
    """
    from lct_python_backend.services.llm_telemetry_service import aggregate_llm_telemetry

    limit = min(max(int(limit), 50), 5000)
    return await aggregate_llm_telemetry(session, limit)


@router.get("/api/settings/llm/models")
async def read_llm_model_options(
    mode: str = "local",
    base_url: Optional[str] = None,
    session=Depends(get_async_session),
):
    merged = await read_llm_settings(session=session)
    resolved_mode = _normalize_mode(mode)
    resolved_base_url = str(base_url or merged.get("base_url") or "").strip()

    if resolved_mode == "online":
        models = await _fetch_online_gemini_models()
        source = "gemini_api"
        if not models:
            models = ONLINE_GEMINI_FALLBACK_MODELS
            source = "fallback"
        return {
            "mode": resolved_mode,
            "provider": "gemini",
            "models": models,
            "source": source,
        }

    models = await _fetch_local_models(resolved_base_url)
    source = "local_api"
    if not models:
        models = LOCAL_CHAT_FALLBACK_MODELS
        source = "fallback"

    return {
        "mode": resolved_mode,
        "provider": "local",
        "base_url": resolved_base_url,
        "models": models,
        "source": source,
    }


@router.put("/api/settings/llm")
async def update_llm_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    merged = merge_llm_config(payload)
    mode = _normalize_mode(merged.get("mode"))
    chat_model = _normalize_model_name(merged.get("chat_model"))

    if mode == "online":
        accepted = await _fetch_online_gemini_models()
        if not accepted:
            accepted = ONLINE_GEMINI_FALLBACK_MODELS
        if chat_model not in accepted:
            accepted_preview = ", ".join(accepted[:8])
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid online chat_model '{chat_model}'. "
                    f"Select one of the accepted Gemini models: {accepted_preview}"
                ),
            )
        payload["chat_model"] = chat_model

    result = await session.execute(
        select(AppSetting).where(AppSetting.key == LLM_CONFIG_KEY)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.value = payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(
            AppSetting(
                key=LLM_CONFIG_KEY,
                value=payload,
            )
        )
    await session.commit()
    return merge_llm_config(payload)


# ── Provider Priority Management ─────────────────────────────────────────────


@router.get("/api/settings/llm/providers")
async def read_llm_providers(session=Depends(get_async_session)):
    """Get LLM provider list with priority order."""
    return await load_llm_providers(session, include_secrets=False)


@router.put("/api/settings/llm/providers")
async def update_llm_providers(payload: Dict[str, Any], session=Depends(get_async_session)):
    """Update LLM provider list (priority order determined by array order)."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    providers = payload.get("providers")
    if not isinstance(providers, list):
        raise HTTPException(status_code=400, detail="providers must be an array.")

    seen_ids: Set[str] = set()
    for i, provider in enumerate(providers):
        if not isinstance(provider, dict):
            raise HTTPException(status_code=400, detail=f"Provider at index {i} must be an object.")
        if not provider.get("id"):
            raise HTTPException(status_code=400, detail=f"Provider at index {i} missing 'id'.")
        provider_id = str(provider.get("id") or "").strip()
        if provider_id in seen_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate provider id '{provider_id}'.")
        seen_ids.add(provider_id)
        if not provider.get("base_url"):
            raise HTTPException(status_code=400, detail=f"Provider at index {i} missing 'base_url'.")
        if not provider.get("model"):
            raise HTTPException(status_code=400, detail=f"Provider at index {i} missing 'model'.")

    return await save_llm_providers(session, payload)


@router.post("/api/settings/llm/providers/health")
async def check_provider_health(payload: Dict[str, Any], session=Depends(get_async_session)):
    """Check health of a single provider endpoint."""
    provider_payload = payload.get("provider") if isinstance(payload.get("provider"), dict) else payload
    if not isinstance(provider_payload, dict):
        raise HTTPException(status_code=400, detail="provider must be an object.")

    provider_id = str(provider_payload.get("id") or "").strip()
    if provider_id:
        config_with_secrets = await load_llm_providers(session, include_secrets=True)
        stored_provider = next(
            (
                item
                for item in config_with_secrets.get("providers", [])
                if str(item.get("id") or "").strip() == provider_id
            ),
            None,
        )
    else:
        stored_provider = None

    resolved_provider = normalize_provider_record(provider_payload, stored_provider)
    base_url = str(resolved_provider.get("base_url") or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="base_url is required.")

    provider_type = str(resolved_provider.get("type") or "openai_compatible").strip().lower()
    api_key = str(resolved_provider.get("api_key") or "").strip()
    health_url = build_provider_api_url(base_url, provider_type, "models")
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(health_url, headers=headers)
            latency_ms = int((time.time() - start) * 1000)
            response.raise_for_status()
            return {
                "healthy": True,
                "status_code": response.status_code,
                "latency_ms": latency_ms,
                "url": health_url,
                "provider_id": provider_id or None,
                "provider_type": provider_type,
            }
    except httpx.HTTPStatusError as exc:
        latency_ms = int((time.time() - start) * 1000)
        return {
            "healthy": False,
            "status_code": exc.response.status_code,
            "error": exc.response.text or f"HTTP {exc.response.status_code}",
            "latency_ms": latency_ms,
            "url": health_url,
            "provider_id": provider_id or None,
            "provider_type": provider_type,
        }
    except Exception as exc:
        latency_ms = int((time.time() - start) * 1000)
        return {
            "healthy": False,
            "error": str(exc),
            "latency_ms": latency_ms,
            "url": health_url,
            "provider_id": provider_id or None,
            "provider_type": provider_type,
        }
