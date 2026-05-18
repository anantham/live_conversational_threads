"""User identity — which IndrasNet contact_id is the LCT user (Aditya).

Used by the participant picker to pre-select self when starting a new
recording. Stored in app_settings under the key `user_identity`. An env
var `LCT_SELF_CONTACT_ID` acts as a fallback when no DB row exists.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import AppSetting

logger = logging.getLogger(__name__)

USER_IDENTITY_KEY = "user_identity"
ENV_SELF_CONTACT_ID = "LCT_SELF_CONTACT_ID"


async def get_self_contact_id(session: AsyncSession) -> Optional[str]:
    """Return the configured self contact_id (DB row, then env fallback)."""
    result = await session.execute(
        select(AppSetting).where(AppSetting.key == USER_IDENTITY_KEY)
    )
    row = result.scalar_one_or_none()
    if row and isinstance(row.value, dict):
        cid = row.value.get("self_contact_id")
        if cid and str(cid).strip():
            return str(cid).strip()

    env_value = os.getenv(ENV_SELF_CONTACT_ID, "").strip()
    return env_value or None


async def set_self_contact_id(
    session: AsyncSession, contact_id: Optional[str]
) -> Optional[str]:
    """Upsert the self contact_id. Pass None to clear.

    Returns the persisted value (None if cleared).
    """
    normalized = str(contact_id).strip() if contact_id else None

    result = await session.execute(
        select(AppSetting).where(AppSetting.key == USER_IDENTITY_KEY)
    )
    row = result.scalar_one_or_none()

    new_value = {"self_contact_id": normalized} if normalized else {"self_contact_id": None}

    if row is None:
        session.add(AppSetting(key=USER_IDENTITY_KEY, value=new_value))
    else:
        row.value = new_value
        row.updated_at = datetime.utcnow()

    await session.commit()
    logger.info("[user_identity] self_contact_id set to %r", normalized)
    return normalized
