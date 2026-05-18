"""
Speaker Analytics API Endpoints
Week 8 implementation
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Dict, List, Any, Optional
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.speaker_analytics import SpeakerAnalytics


router = APIRouter(prefix="/api/analytics", tags=["analytics"])


class AnalyticsResponse(BaseModel):
    """Response model for speaker analytics"""
    speakers: Dict[str, Any]
    timeline: List[Dict[str, Any]]
    roles: Dict[str, str]
    summary: Dict[str, Any]


class SpeakerStatsResponse(BaseModel):
    """Response model for individual speaker stats"""
    speaker_id: str
    speaker_name: str
    time_spoken_seconds: float
    time_spoken_percentage: float
    turn_count: int
    turn_percentage: float
    topics_dominated: List[str]
    role: str
    avg_turn_duration: float


@router.get("/conversations/{conversation_id}/analytics", response_model=AnalyticsResponse)
async def get_conversation_analytics(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Comprehensive speaker analytics for a conversation."""
    try:
        analytics_service = SpeakerAnalytics(db)
        analytics = await analytics_service.calculate_full_analytics(conversation_id)
        if not analytics["speakers"]:
            raise HTTPException(
                status_code=404,
                detail=f"No analytics data found for conversation {conversation_id}",
            )
        return analytics
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to calculate analytics: {str(e)}",
        )


@router.get("/conversations/{conversation_id}/speakers/{speaker_id}", response_model=SpeakerStatsResponse)
async def get_speaker_stats(
    conversation_id: str,
    speaker_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Statistics for a specific speaker in a conversation."""
    try:
        analytics_service = SpeakerAnalytics(db)
        analytics = await analytics_service.calculate_full_analytics(conversation_id)
        if speaker_id not in analytics["speakers"]:
            raise HTTPException(
                status_code=404,
                detail=f"Speaker {speaker_id} not found in conversation {conversation_id}",
            )
        return analytics["speakers"][speaker_id]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get speaker stats: {str(e)}",
        )


@router.get("/conversations/{conversation_id}/timeline", response_model=List[Dict[str, Any]])
async def get_speaker_timeline(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Chronological timeline of speaker activity."""
    try:
        analytics_service = SpeakerAnalytics(db)
        analytics = await analytics_service.calculate_full_analytics(conversation_id)
        return analytics["timeline"]
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get timeline: {str(e)}",
        )


@router.get("/conversations/{conversation_id}/roles", response_model=Dict[str, str])
async def get_speaker_roles(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Detected speaker roles (facilitator / contributor / observer)."""
    try:
        analytics_service = SpeakerAnalytics(db)
        analytics = await analytics_service.calculate_full_analytics(conversation_id)
        return analytics["roles"]
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get roles: {str(e)}",
        )
