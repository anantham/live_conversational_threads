"""STT settings persistence service."""

import logging
from datetime import datetime
from typing import Any, Dict

from sqlalchemy import select

from lct_python_backend.models import AppSetting
from lct_python_backend.services.stt_config import (
    STT_CONFIG_KEY,
    get_env_stt_defaults,
    merge_stt_config,
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


async def load_stt_settings(session) -> Dict[str, Any]:
    """Load merged STT settings from DB overrides + env defaults."""
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


async def save_stt_settings(session, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Persist STT settings overrides and return the merged config."""
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    stmt = select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing:
        existing.value = payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=STT_CONFIG_KEY, value=payload))
    await session.commit()
    return merge_stt_config(payload)
