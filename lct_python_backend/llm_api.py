from typing import Any, Dict

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import AppSetting
from lct_python_backend.services.llm_config import LLM_CONFIG_KEY, merge_llm_config

router = APIRouter()


@router.get("/api/settings/llm")
async def read_llm_settings(session=Depends(get_async_session)):
    result = await session.execute(
        select(AppSetting).where(AppSetting.key == LLM_CONFIG_KEY)
    )
    setting = result.scalar_one_or_none()
    overrides = setting.value if setting else {}
    return merge_llm_config(overrides)


@router.put("/api/settings/llm")
async def update_llm_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

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
