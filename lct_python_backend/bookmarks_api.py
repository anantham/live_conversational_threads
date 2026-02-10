"""
API endpoints for managing bookmarks.

Thin router — delegates all persistence/query logic to ``bookmark_service``.
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.bookmark_service import (
    create_bookmark as _create_bookmark,
    delete_bookmark as _delete_bookmark,
    get_bookmark_by_id,
    list_bookmarks as _list_bookmarks,
    list_conversation_bookmarks,
    serialize_bookmark,
    update_bookmark as _update_bookmark,
)

logger = logging.getLogger(__name__)


# ── Pydantic models ─────────────────────────────────────────────────────────

class CreateBookmarkRequest(BaseModel):
    """Request model for creating a bookmark."""
    conversation_id: str
    utterance_ids: Optional[List[str]] = None
    turn_id: Optional[str] = None
    speaker_id: Optional[str] = None
    turn_summary: Optional[str] = None
    full_text: str
    notes: Optional[str] = None
    created_by: Optional[str] = "anonymous"


class UpdateBookmarkRequest(BaseModel):
    """Request model for updating a bookmark."""
    notes: Optional[str] = None
    turn_summary: Optional[str] = None


class BookmarkResponse(BaseModel):
    """Response model for bookmark."""
    id: str
    conversation_id: str
    utterance_ids: Optional[List[str]]
    turn_id: Optional[str]
    speaker_id: Optional[str]
    turn_summary: Optional[str]
    full_text: str
    notes: Optional[str]
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BookmarksListResponse(BaseModel):
    """Response model for list of bookmarks."""
    bookmarks: List[BookmarkResponse]
    count: int


# ── Router ───────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


@router.get("/health", tags=["health"])
async def health_check():
    """Health check endpoint for bookmarks API."""
    return {
        "status": "healthy",
        "service": "bookmarks_api",
        "timestamp": datetime.now().isoformat(),
    }


@router.post("", response_model=BookmarkResponse)
async def create_bookmark(
    request: CreateBookmarkRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Create a new bookmark for a conversation turn."""
    try:
        bookmark = await _create_bookmark(
            db,
            conversation_id=request.conversation_id,
            utterance_ids=request.utterance_ids,
            turn_id=request.turn_id,
            speaker_id=request.speaker_id,
            turn_summary=request.turn_summary,
            full_text=request.full_text,
            notes=request.notes,
            created_by=request.created_by,
        )
        return BookmarkResponse(**serialize_bookmark(bookmark))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to create bookmark: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create bookmark: {exc}")


@router.get("", response_model=BookmarksListResponse)
async def get_bookmarks(
    created_by: Optional[str] = None,
    db: AsyncSession = Depends(get_async_session),
):
    """Get all bookmarks, optionally filtered by user."""
    try:
        bookmarks = await _list_bookmarks(db, created_by=created_by)
        items = [BookmarkResponse(**serialize_bookmark(b)) for b in bookmarks]
        return BookmarksListResponse(bookmarks=items, count=len(items))
    except Exception as exc:
        logger.error("Failed to fetch bookmarks: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmarks: {exc}")


@router.get("/conversation/{conversation_id}", response_model=BookmarksListResponse)
async def get_conversation_bookmarks_endpoint(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get all bookmarks for a specific conversation."""
    try:
        bookmarks = await list_conversation_bookmarks(db, conversation_id)
        items = [BookmarkResponse(**serialize_bookmark(b)) for b in bookmarks]
        return BookmarksListResponse(bookmarks=items, count=len(items))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to fetch bookmarks: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmarks: {exc}")


@router.get("/{bookmark_id}", response_model=BookmarkResponse)
async def get_bookmark(
    bookmark_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get a specific bookmark by ID."""
    try:
        bookmark = await get_bookmark_by_id(db, bookmark_id)
        return BookmarkResponse(**serialize_bookmark(bookmark))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to fetch bookmark: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmark: {exc}")


@router.patch("/{bookmark_id}", response_model=BookmarkResponse)
async def update_bookmark(
    bookmark_id: str,
    request: UpdateBookmarkRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update a bookmark's notes or summary."""
    try:
        bookmark = await _update_bookmark(
            db, bookmark_id,
            notes=request.notes,
            turn_summary=request.turn_summary,
        )
        return BookmarkResponse(**serialize_bookmark(bookmark))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to update bookmark: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update bookmark: {exc}")


@router.delete("/{bookmark_id}")
async def delete_bookmark(
    bookmark_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete a bookmark."""
    try:
        await _delete_bookmark(db, bookmark_id)
        return {"success": True, "message": f"Bookmark {bookmark_id} deleted successfully"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to delete bookmark: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete bookmark: {exc}")
