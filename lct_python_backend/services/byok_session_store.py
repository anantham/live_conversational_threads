"""Ephemeral BYOK session storage for short-lived STT + LLM credentials."""

from __future__ import annotations

import copy
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional, Set

import httpx

from lct_python_backend.services.llm_config import DEFAULT_OPENAI_BASE_URL
from lct_python_backend.services.stt.stt_config import (
    DEFAULT_OPENAI_AUDIO_BASE_URL,
    DEFAULT_OPENAI_AUDIO_DIARIZE_MODEL,
    DEFAULT_OPENAI_AUDIO_MODEL,
    normalize_cloud_provider_base_url,
)

BYOK_PROVIDER_IDS = ("openai_audio",)
BYOK_SCOPE_LLM_IMPORT = "llm_import"
BYOK_SCOPE_LLM_LIVE = "llm_live"
BYOK_SCOPE_STT_IMPORT = "stt_import"
BYOK_SCOPE_STT_LIVE = "stt_live"
BYOK_SCOPE_IDS = (
    BYOK_SCOPE_STT_IMPORT,
    BYOK_SCOPE_STT_LIVE,
    BYOK_SCOPE_LLM_IMPORT,
    BYOK_SCOPE_LLM_LIVE,
)
DEFAULT_BYOK_TTL_SECONDS = 1800
MIN_BYOK_TTL_SECONDS = 300
MAX_BYOK_TTL_SECONDS = 7200
DEFAULT_BYOK_OPENAI_CHAT_MODEL = os.getenv("BYOK_OPENAI_CHAT_MODEL", "gpt-4.1-mini").strip() or "gpt-4.1-mini"
DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS = float(os.getenv("BYOK_OPENAI_TIMEOUT_SECONDS", "120"))
BYOK_LLM_PROVIDER_ID = "byok_openai"

_OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models"
_BYOK_LOCK = threading.Lock()
_BYOK_SESSIONS: Dict[str, "ByokSessionRecord"] = {}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_provider(value: Any) -> str:
    provider = str(value or "openai_audio").strip().lower()
    if provider not in BYOK_PROVIDER_IDS:
        raise ValueError(f"provider must be one of: {', '.join(BYOK_PROVIDER_IDS)}")
    return provider


def _normalize_scopes(raw_scopes: Any) -> Set[str]:
    if raw_scopes is None:
        return set(BYOK_SCOPE_IDS)
    if isinstance(raw_scopes, str):
        values = [part.strip().lower() for part in raw_scopes.split(",")]
    elif isinstance(raw_scopes, Iterable):
        values = [str(part or "").strip().lower() for part in raw_scopes]
    else:
        raise ValueError("scopes must be a string or array of strings")

    scopes = {value for value in values if value}
    if not scopes:
        return set(BYOK_SCOPE_IDS)
    unknown = scopes.difference(BYOK_SCOPE_IDS)
    if unknown:
        raise ValueError(f"unsupported BYOK scopes: {', '.join(sorted(unknown))}")
    return scopes


def _normalize_ttl_seconds(raw_ttl: Any) -> int:
    if raw_ttl is None:
        return DEFAULT_BYOK_TTL_SECONDS
    try:
        parsed = int(raw_ttl)
    except (TypeError, ValueError) as exc:
        raise ValueError("ttl_seconds must be an integer") from exc
    return min(MAX_BYOK_TTL_SECONDS, max(MIN_BYOK_TTL_SECONDS, parsed))


@dataclass
class ByokSessionRecord:
    token: str
    provider: str
    scopes: Set[str]
    api_key: str
    base_url: str
    model: str
    diarize_model: str
    llm_model: str
    ttl_seconds: int
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime

    def touch(self, now: Optional[datetime] = None) -> None:
        touched_at = now or _utcnow()
        self.last_used_at = touched_at
        self.expires_at = touched_at + timedelta(seconds=self.ttl_seconds)

    def public_payload(self) -> Dict[str, Any]:
        return {
            "byok_session_token": self.token,
            "provider": self.provider,
            "scopes": sorted(self.scopes),
            "expires_at": _isoformat_utc(self.expires_at),
        }

    def secret_payload(self) -> Dict[str, Any]:
        return {
            "token": self.token,
            "provider": self.provider,
            "scopes": set(self.scopes),
            "api_key": self.api_key,
            "base_url": self.base_url,
            "model": self.model,
            "diarize_model": self.diarize_model,
            "llm_model": self.llm_model,
            "ttl_seconds": self.ttl_seconds,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
            "expires_at": self.expires_at,
        }


class ByokSessionLookupError(ValueError):
    """Raised when a BYOK session token is missing, expired, or unauthorized."""


def _prune_expired_locked(now: Optional[datetime] = None) -> None:
    current = now or _utcnow()
    expired_tokens = [
        token
        for token, record in _BYOK_SESSIONS.items()
        if record.expires_at <= current
    ]
    for token in expired_tokens:
        _BYOK_SESSIONS.pop(token, None)


async def validate_byok_api_key(*, provider: Any, api_key: Any, timeout_seconds: float = 10.0) -> None:
    normalized_provider = _normalize_provider(provider)
    normalized_key = str(api_key or "").strip()
    if not normalized_key:
        raise ValueError("api_key is required")

    if normalized_provider != "openai_audio":
        raise ValueError(f"provider validation is not implemented for '{normalized_provider}'")

    headers = {"Authorization": f"Bearer {normalized_key}"}
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.get(_OPENAI_MODELS_ENDPOINT, headers=headers)
    except httpx.TimeoutException as exc:
        raise RuntimeError("Timed out while validating the OpenAI API key.") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"OpenAI API key validation request failed: {exc}") from exc

    if response.status_code in {401, 403}:
        raise ValueError("OpenAI API key was rejected.")
    if response.status_code >= 400:
        raise RuntimeError(
            f"OpenAI API key validation failed with status {response.status_code}."
        )


async def create_byok_session(
    *,
    provider: Any,
    api_key: Any,
    scopes: Any = None,
    ttl_seconds: Any = None,
    base_url: Any = None,
    model: Any = None,
    diarize_model: Any = None,
    llm_model: Any = None,
) -> Dict[str, Any]:
    normalized_provider = _normalize_provider(provider)
    normalized_key = str(api_key or "").strip()
    normalized_scopes = _normalize_scopes(scopes)
    normalized_ttl_seconds = _normalize_ttl_seconds(ttl_seconds)

    await validate_byok_api_key(
        provider=normalized_provider,
        api_key=normalized_key,
    )

    resolved_base_url = normalize_cloud_provider_base_url(
        normalized_provider,
        base_url or DEFAULT_OPENAI_AUDIO_BASE_URL,
    ) or DEFAULT_OPENAI_AUDIO_BASE_URL
    resolved_model = str(model or DEFAULT_OPENAI_AUDIO_MODEL).strip() or DEFAULT_OPENAI_AUDIO_MODEL
    resolved_diarize_model = (
        str(diarize_model or DEFAULT_OPENAI_AUDIO_DIARIZE_MODEL).strip()
        or DEFAULT_OPENAI_AUDIO_DIARIZE_MODEL
    )
    resolved_llm_model = str(llm_model or DEFAULT_BYOK_OPENAI_CHAT_MODEL).strip() or DEFAULT_BYOK_OPENAI_CHAT_MODEL

    now = _utcnow()
    record = ByokSessionRecord(
        token=secrets.token_urlsafe(32),
        provider=normalized_provider,
        scopes=normalized_scopes,
        api_key=normalized_key,
        base_url=resolved_base_url,
        model=resolved_model,
        diarize_model=resolved_diarize_model,
        llm_model=resolved_llm_model,
        ttl_seconds=normalized_ttl_seconds,
        created_at=now,
        last_used_at=now,
        expires_at=now + timedelta(seconds=normalized_ttl_seconds),
    )
    with _BYOK_LOCK:
        _prune_expired_locked(now)
        _BYOK_SESSIONS[record.token] = record
    return record.public_payload()


def resolve_byok_session(token: Any, *, required_scope: Optional[str] = None, touch: bool = True) -> Dict[str, Any]:
    normalized_token = str(token or "").strip()
    if not normalized_token:
        raise ByokSessionLookupError("Missing BYOK session token.")

    if required_scope and required_scope not in BYOK_SCOPE_IDS:
        raise ValueError(f"unsupported BYOK scope: {required_scope}")

    now = _utcnow()
    with _BYOK_LOCK:
        _prune_expired_locked(now)
        record = _BYOK_SESSIONS.get(normalized_token)
        if record is None:
            raise ByokSessionLookupError("BYOK session token is missing or expired.")
        if required_scope and required_scope not in record.scopes:
            raise ByokSessionLookupError(
                f"BYOK session token does not allow '{required_scope}'."
            )
        if touch:
            record.touch(now)
        return record.secret_payload()


def build_runtime_stt_settings_for_byok(
    settings: Optional[Dict[str, Any]],
    byok_session: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    runtime_settings: Dict[str, Any] = copy.deepcopy(settings or {})
    if not isinstance(byok_session, dict):
        return runtime_settings

    cloud_providers = (
        runtime_settings.get("cloud_fallback_providers")
        if isinstance(runtime_settings.get("cloud_fallback_providers"), dict)
        else {}
    )
    openai_provider = (
        cloud_providers.get("openai_audio")
        if isinstance(cloud_providers.get("openai_audio"), dict)
        else {}
    )
    runtime_settings["local_only"] = False
    runtime_settings["live_cloud_fallback_enabled"] = True
    runtime_settings["cloud_fallback_providers"] = {
        **cloud_providers,
        "openai_audio": {
            **openai_provider,
            "id": "openai_audio",
            "name": str(openai_provider.get("name") or "OpenAI Audio"),
            "enabled": True,
            "base_url": str(byok_session.get("base_url") or DEFAULT_OPENAI_AUDIO_BASE_URL),
            "model": str(byok_session.get("model") or DEFAULT_OPENAI_AUDIO_MODEL),
            "diarize_model": str(
                byok_session.get("diarize_model") or DEFAULT_OPENAI_AUDIO_DIARIZE_MODEL
            ),
            "api_key": str(byok_session.get("api_key") or ""),
            "supports_diarization": True,
            "degraded": False,
        },
    }
    return runtime_settings


def _has_llm_scope(byok_session: Optional[Dict[str, Any]], required_scope: str) -> bool:
    if not isinstance(byok_session, dict):
        return False
    scopes = byok_session.get("scopes")
    if not isinstance(scopes, set):
        return False
    return required_scope in scopes


def build_runtime_llm_config_for_byok(
    config: Optional[Dict[str, Any]],
    byok_session: Optional[Dict[str, Any]],
    *,
    required_scope: str,
) -> Dict[str, Any]:
    runtime_config: Dict[str, Any] = copy.deepcopy(config or {})
    if required_scope not in {BYOK_SCOPE_LLM_LIVE, BYOK_SCOPE_LLM_IMPORT}:
        raise ValueError(f"unsupported BYOK scope: {required_scope}")
    if not _has_llm_scope(byok_session, required_scope):
        return runtime_config

    llm_model = str(byok_session.get("llm_model") or DEFAULT_BYOK_OPENAI_CHAT_MODEL).strip() or DEFAULT_BYOK_OPENAI_CHAT_MODEL
    runtime_config["mode"] = "local"
    runtime_config["base_url"] = DEFAULT_OPENAI_BASE_URL
    runtime_config["chat_model"] = llm_model
    runtime_config["json_mode"] = True
    runtime_config["timeout_seconds"] = float(
        runtime_config.get("timeout_seconds") or DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS
    )
    runtime_config["backend"] = f"openai_{llm_model}"
    return runtime_config


def build_runtime_llm_providers_for_byok(
    providers: Optional[list[Dict[str, Any]]],
    byok_session: Optional[Dict[str, Any]],
    *,
    required_scope: str,
) -> list[Dict[str, Any]]:
    runtime_providers = copy.deepcopy(providers or [])
    if required_scope not in {BYOK_SCOPE_LLM_LIVE, BYOK_SCOPE_LLM_IMPORT}:
        raise ValueError(f"unsupported BYOK scope: {required_scope}")
    if not _has_llm_scope(byok_session, required_scope):
        return runtime_providers

    llm_model = str(byok_session.get("llm_model") or DEFAULT_BYOK_OPENAI_CHAT_MODEL).strip() or DEFAULT_BYOK_OPENAI_CHAT_MODEL
    return [
        {
            "id": BYOK_LLM_PROVIDER_ID,
            "name": "BYOK OpenAI",
            "type": "openai",
            "base_url": DEFAULT_OPENAI_BASE_URL,
            "model": llm_model,
            "api_key": str(byok_session.get("api_key") or ""),
            "enabled": True,
            "timeout_seconds": DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS,
            "session_scoped": True,
        }
    ]
