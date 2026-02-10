"""STT settings persistence service."""

import logging
from datetime import datetime
from typing import Any, Dict

from sqlalchemy import select

from lct_python_backend.models import AppSetting
from lct_python_backend.services.stt_config import STT_CONFIG_KEY, merge_stt_config

logger = logging.getLogger(__name__)


async def load_stt_settings(session) -> Dict[str, Any]:
    """Load merged STT settings from DB overrides + env defaults."""
    setting = await session.execute(
        select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    )
    value = setting.scalar_one_or_none()
    overrides = value.value if value else {}
    return merge_stt_config(overrides)


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
