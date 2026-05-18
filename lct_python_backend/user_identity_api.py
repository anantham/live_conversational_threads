"""User identity endpoints — read/write the LCT user's IndrasNet contact_id.

The participant picker on NewConversation uses this to pre-select self.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.user_identity_service import (
    get_self_contact_id,
    set_self_contact_id,
)

logger = logging.getLogger("lct_backend")

router = APIRouter(prefix="/api/user-identity", tags=["user-identity"])


class UserIdentityResponse(BaseModel):
    self_contact_id: Optional[str] = None


class UserIdentityUpdate(BaseModel):
    self_contact_id: Optional[str] = None


@router.get("", response_model=UserIdentityResponse)
async def read_user_identity(db: AsyncSession = Depends(get_async_session)):
    return UserIdentityResponse(self_contact_id=await get_self_contact_id(db))


@router.put("", response_model=UserIdentityResponse)
async def update_user_identity(
    payload: UserIdentityUpdate,
    db: AsyncSession = Depends(get_async_session),
):
    saved = await set_self_contact_id(db, payload.self_contact_id)
    return UserIdentityResponse(self_contact_id=saved)
