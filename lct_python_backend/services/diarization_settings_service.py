"""Diarization settings persistence (mirrors stt_settings_service)."""

import logging
from datetime import datetime
from typing import Any, Dict

from sqlalchemy import select

from lct_python_backend.models import AppSetting
from lct_python_backend.services.diarization_config import (
    DIARIZATION_CONFIG_KEY,
    merge_diarization_config,
    sanitize_diarization_config_for_client,
)

logger = logging.getLogger("lct_backend")


async def load_diarization_settings(session) -> Dict[str, Any]:
    """Load merged diarization settings from DB overrides + env defaults."""
    result = await session.execute(
        select(AppSetting).where(AppSetting.key == DIARIZATION_CONFIG_KEY)
    )
    value = result.scalar_one_or_none()
    overrides = value.value if value and isinstance(value.value, dict) else {}
    return merge_diarization_config(overrides)


async def load_diarization_settings_for_client(session) -> Dict[str, Any]:
    return sanitize_diarization_config_for_client(await load_diarization_settings(session))


async def save_diarization_settings(session, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Persist diarization overrides and return the merged, client-safe config."""
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    # Normalize through merge so we only persist clean, validated values.
    normalized = merge_diarization_config(payload)

    stmt = select(AppSetting).where(AppSetting.key == DIARIZATION_CONFIG_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing:
        existing.value = normalized
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=DIARIZATION_CONFIG_KEY, value=normalized))
    await session.commit()

    return sanitize_diarization_config_for_client(normalized)
