"""Artifact export settings API."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.artifact_export_service import (
    reroute_conversation_artifacts,
)
from lct_python_backend.services.artifact_settings_service import (
    load_artifact_export_settings,
    normalize_artifact_export_settings,
    probe_artifact_export_path,
    save_artifact_export_settings,
)

settings_router = APIRouter(prefix="/api/settings/artifact-export", tags=["artifact-export"])
conversation_router = APIRouter(prefix="/api/conversations", tags=["artifact-export"])
router = APIRouter()


@settings_router.get("")
async def get_artifact_export_settings(
    db: AsyncSession = Depends(get_async_session),
):
    return await load_artifact_export_settings(db)


@settings_router.put("")
async def put_artifact_export_settings(
    payload: Dict[str, Any],
    db: AsyncSession = Depends(get_async_session),
):
    try:
        return await save_artifact_export_settings(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@settings_router.post("/test-write")
async def post_artifact_export_test_write(
    payload: Dict[str, Any] = Body(default_factory=dict),
    db: AsyncSession = Depends(get_async_session),
):
    try:
        candidate_settings = (
            normalize_artifact_export_settings(payload)
            if payload
            else await load_artifact_export_settings(db)
        )
        return probe_artifact_export_path(candidate_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@conversation_router.post("/{conversation_id}/artifacts/reroute")
async def post_reroute_conversation_artifacts(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    try:
        settings = await load_artifact_export_settings(db)
        return await reroute_conversation_artifacts(
            db=db,
            conversation_id=conversation_id,
            settings=settings,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


router.include_router(settings_router)
router.include_router(conversation_router)
