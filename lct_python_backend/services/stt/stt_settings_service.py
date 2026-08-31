"""STT settings persistence service."""

import logging
from datetime import datetime
from typing import Any, Dict, Mapping

from sqlalchemy import select

from lct_python_backend.models import AppSetting
from .stt_config import (
    STT_CONFIG_KEY,
    STT_CLOUD_PROVIDER_IDS,
    get_env_stt_defaults,
    merge_stt_config,
    normalize_cloud_provider_record,
    sanitize_stt_config_for_client,
)

logger = logging.getLogger(__name__)


def _is_legacy_modal_whisper_url(url: str) -> bool:
    normalized = str(url or "").strip().lower()
    return "adityaarpitha--whisperx-server-serve.modal.run" in normalized


def _normalize_legacy_whisper_overrides(overrides: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
    if not isinstance(overrides, dict):
        return {}, False

    normalized_overrides = dict(overrides)
    provider_http_urls_raw = normalized_overrides.get("provider_http_urls")
    provider_http_urls = dict(provider_http_urls_raw) if isinstance(provider_http_urls_raw, dict) else {}

    provider = str(normalized_overrides.get("provider") or "").strip().lower()
    configured_whisper_url = str(provider_http_urls.get("whisper") or "").strip()
    active_http_url = str(normalized_overrides.get("http_url") or "").strip()
    has_legacy_whisper_url = _is_legacy_modal_whisper_url(configured_whisper_url)
    has_legacy_active_url = provider == "whisper" and _is_legacy_modal_whisper_url(active_http_url)
    if not (has_legacy_whisper_url or has_legacy_active_url):
        return normalized_overrides, False

    default_whisper_http_url = str(
        get_env_stt_defaults().get("provider_http_urls", {}).get("whisper") or ""
    ).strip()
    if not default_whisper_http_url or _is_legacy_modal_whisper_url(default_whisper_http_url):
        return normalized_overrides, False

    provider_http_urls["whisper"] = default_whisper_http_url
    normalized_overrides["provider_http_urls"] = provider_http_urls
    if provider == "whisper" and (not active_http_url or _is_legacy_modal_whisper_url(active_http_url)):
        normalized_overrides["http_url"] = default_whisper_http_url
    return normalized_overrides, True


def _preserve_cloud_provider_secrets(
    payload: Dict[str, Any],
    existing_value: Mapping[str, Any],
) -> Dict[str, Any]:
    normalized_payload = {
        key: value
        for key, value in dict(payload).items()
        if key != "local_authorities" and not str(key).startswith("_validated_stt_")
    }
    incoming_raw = normalized_payload.get("cloud_fallback_providers")
    incoming_providers = dict(incoming_raw) if isinstance(incoming_raw, Mapping) else {}
    existing_raw = existing_value.get("cloud_fallback_providers")
    existing_providers = dict(existing_raw) if isinstance(existing_raw, Mapping) else {}

    merged_providers: Dict[str, Dict[str, Any]] = {}
    for provider_id in STT_CLOUD_PROVIDER_IDS:
        raw_provider = incoming_providers.get(provider_id)
        provider_for_save = dict(raw_provider) if isinstance(raw_provider, Mapping) else {}
        if (
            provider_for_save.get("api_key") is not None
            and not str(provider_for_save.get("api_key") or "").strip()
            and not str(provider_for_save.get("clear_api_key", "")).strip().lower() in {"1", "true", "yes", "on"}
        ):
            provider_for_save.pop("api_key", None)
        merged_providers[provider_id] = normalize_cloud_provider_record(
            provider_id,
            provider_for_save,
            existing_providers.get(provider_id),
        )

    normalized_payload["cloud_fallback_providers"] = merged_providers
    return normalized_payload


async def load_stt_settings(session) -> Dict[str, Any]:
    """Load merged STT settings from DB overrides + env defaults, including secrets."""
    setting = await session.execute(
        select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    )
    value = setting.scalar_one_or_none()
    overrides = value.value if value and isinstance(value.value, dict) else {}

    normalized_overrides, migrated = _normalize_legacy_whisper_overrides(overrides)
    if migrated and value:
        value.value = normalized_overrides
        value.updated_at = datetime.utcnow()
        try:
            await session.commit()
            logger.info("Normalized legacy Modal whisper HTTP URL override in app_settings.")
        except Exception:
            await session.rollback()
            logger.exception("Failed to persist normalized STT whisper override; continuing with in-memory defaults.")

    return merge_stt_config(normalized_overrides)


async def load_stt_settings_for_client(session) -> Dict[str, Any]:
    """Load STT settings with secrets masked for browser consumption."""
    return sanitize_stt_config_for_client(await load_stt_settings(session))


async def save_stt_settings(
    session,
    payload: Dict[str, Any],
    *,
    include_secrets: bool = False,
) -> Dict[str, Any]:
    """Persist STT settings overrides and return the merged config."""
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    stmt = select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    existing_value = existing.value if existing and isinstance(existing.value, dict) else {}
    normalized_payload = _preserve_cloud_provider_secrets(payload, existing_value)

    if existing:
        existing.value = normalized_payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=STT_CONFIG_KEY, value=normalized_payload))
    await session.commit()

    merged = merge_stt_config(normalized_payload)
    if include_secrets:
        return merged
    return sanitize_stt_config_for_client(merged)
