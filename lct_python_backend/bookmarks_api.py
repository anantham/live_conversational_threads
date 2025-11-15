"""
API endpoints for managing bookmarks.

Provides endpoints for:
- Creating bookmarks for conversation turns
- Retrieving bookmarks (all, by conversation, by user)
- Updating bookmark notes
- Deleting bookmarks
"""

import logging
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import Optional, List
from datetime import datetime
import uuid

from pydantic import BaseModel

# Configure logger
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

from lct_python_backend.models import Bookmark
from lct_python_backend.db_session import get_async_session


# Pydantic models for API requests/responses

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

    class Config:
        from_attributes = True


class BookmarksListResponse(BaseModel):
    """Response model for list of bookmarks."""
    bookmarks: List[BookmarkResponse]
    count: int


# Create router
router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


@router.post("", response_model=BookmarkResponse)
async def create_bookmark(
    request: CreateBookmarkRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Create a new bookmark for a conversation turn.

    Args:
        request: Bookmark creation data
        db: Database session

    Returns:
        BookmarkResponse with created bookmark data
    """
    logger.info(f"=== Creating bookmark for conversation {request.conversation_id} ===")
    logger.info(f"Turn ID: {request.turn_id}, Speaker: {request.speaker_id}")
    logger.info(f"Created by: {request.created_by}")

    try:
        # Convert string UUIDs to UUID objects
        bookmark_id = uuid.uuid4()
        conversation_uuid = uuid.UUID(request.conversation_id)

        utterance_uuids = None
        if request.utterance_ids:
            utterance_uuids = [uuid.UUID(uid) for uid in request.utterance_ids]

        # Create bookmark record
        bookmark = Bookmark(
            id=bookmark_id,
            conversation_id=conversation_uuid,
            utterance_ids=utterance_uuids,
            turn_id=request.turn_id,
            speaker_id=request.speaker_id,
            turn_summary=request.turn_summary,
            full_text=request.full_text,
            notes=request.notes,
            created_by=request.created_by,
        )

        db.add(bookmark)
        await db.commit()
        await db.refresh(bookmark)

        logger.info(f"✅ Bookmark created successfully with ID: {bookmark.id}")

        # Convert to response format
        return BookmarkResponse(
            id=str(bookmark.id),
            conversation_id=str(bookmark.conversation_id),
            utterance_ids=[str(uid) for uid in bookmark.utterance_ids] if bookmark.utterance_ids else None,
            turn_id=bookmark.turn_id,
            speaker_id=bookmark.speaker_id,
            turn_summary=bookmark.turn_summary,
            full_text=bookmark.full_text,
            notes=bookmark.notes,
            created_by=bookmark.created_by,
            created_at=bookmark.created_at,
            updated_at=bookmark.updated_at,
        )

    except ValueError as e:
        logger.error(f"Invalid UUID format: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid UUID format: {str(e)}")

    except Exception as e:
        logger.error(f"Failed to create bookmark: {str(e)}")
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create bookmark: {str(e)}")


@router.get("", response_model=BookmarksListResponse)
async def get_bookmarks(
    created_by: Optional[str] = None,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Get all bookmarks, optionally filtered by user.

    Args:
        created_by: Optional user ID to filter by
        db: Database session

    Returns:
        BookmarksListResponse with list of bookmarks
    """
    logger.info(f"=== Fetching bookmarks ===")
    logger.info(f"Filter by user: {created_by or 'None (all users)'}")

    try:
        # Build query
        query = select(Bookmark).order_by(Bookmark.created_at.desc())

        if created_by:
            query = query.where(Bookmark.created_by == created_by)

        # Execute query
        result = await db.execute(query)
        bookmarks = result.scalars().all()

        logger.info(f"✅ Found {len(bookmarks)} bookmarks")

        # Convert to response format
        bookmark_responses = [
            BookmarkResponse(
                id=str(b.id),
                conversation_id=str(b.conversation_id),
                utterance_ids=[str(uid) for uid in b.utterance_ids] if b.utterance_ids else None,
                turn_id=b.turn_id,
                speaker_id=b.speaker_id,
                turn_summary=b.turn_summary,
                full_text=b.full_text,
                notes=b.notes,
                created_by=b.created_by,
                created_at=b.created_at,
                updated_at=b.updated_at,
            )
            for b in bookmarks
        ]

        return BookmarksListResponse(
            bookmarks=bookmark_responses,
            count=len(bookmark_responses),
        )

    except Exception as e:
        logger.error(f"Failed to fetch bookmarks: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmarks: {str(e)}")


@router.get("/conversation/{conversation_id}", response_model=BookmarksListResponse)
async def get_conversation_bookmarks(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Get all bookmarks for a specific conversation.

    Args:
        conversation_id: Conversation UUID
        db: Database session

    Returns:
        BookmarksListResponse with list of bookmarks for this conversation
    """
    logger.info(f"=== Fetching bookmarks for conversation {conversation_id} ===")

    try:
        # Convert to UUID
        conversation_uuid = uuid.UUID(conversation_id)

        # Build query
        query = select(Bookmark).where(
            Bookmark.conversation_id == conversation_uuid
        ).order_by(Bookmark.created_at.desc())

        # Execute query
        result = await db.execute(query)
        bookmarks = result.scalars().all()

        logger.info(f"✅ Found {len(bookmarks)} bookmarks for conversation {conversation_id}")

        # Convert to response format
        bookmark_responses = [
            BookmarkResponse(
                id=str(b.id),
                conversation_id=str(b.conversation_id),
                utterance_ids=[str(uid) for uid in b.utterance_ids] if b.utterance_ids else None,
                turn_id=b.turn_id,
                speaker_id=b.speaker_id,
                turn_summary=b.turn_summary,
                full_text=b.full_text,
                notes=b.notes,
                created_by=b.created_by,
                created_at=b.created_at,
                updated_at=b.updated_at,
            )
            for b in bookmarks
        ]

        return BookmarksListResponse(
            bookmarks=bookmark_responses,
            count=len(bookmark_responses),
        )

    except ValueError as e:
        logger.error(f"Invalid UUID format: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid UUID format: {str(e)}")

    except Exception as e:
        logger.error(f"Failed to fetch bookmarks: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmarks: {str(e)}")


@router.get("/{bookmark_id}", response_model=BookmarkResponse)
async def get_bookmark(
    bookmark_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Get a specific bookmark by ID.

    Args:
        bookmark_id: Bookmark UUID
        db: Database session

    Returns:
        BookmarkResponse with bookmark data
    """
    logger.info(f"=== Fetching bookmark {bookmark_id} ===")

    try:
        # Convert to UUID
        bookmark_uuid = uuid.UUID(bookmark_id)

        # Query for bookmark
        query = select(Bookmark).where(Bookmark.id == bookmark_uuid)
        result = await db.execute(query)
        bookmark = result.scalar_one_or_none()

        if not bookmark:
            logger.error(f"Bookmark {bookmark_id} not found")
            raise HTTPException(status_code=404, detail=f"Bookmark {bookmark_id} not found")

        logger.info(f"✅ Found bookmark {bookmark_id}")

        # Convert to response format
        return BookmarkResponse(
            id=str(bookmark.id),
            conversation_id=str(bookmark.conversation_id),
            utterance_ids=[str(uid) for uid in bookmark.utterance_ids] if bookmark.utterance_ids else None,
            turn_id=bookmark.turn_id,
            speaker_id=bookmark.speaker_id,
            turn_summary=bookmark.turn_summary,
            full_text=bookmark.full_text,
            notes=bookmark.notes,
            created_by=bookmark.created_by,
            created_at=bookmark.created_at,
            updated_at=bookmark.updated_at,
        )

    except ValueError as e:
        logger.error(f"Invalid UUID format: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid UUID format: {str(e)}")

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Failed to fetch bookmark: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch bookmark: {str(e)}")


@router.patch("/{bookmark_id}", response_model=BookmarkResponse)
async def update_bookmark(
    bookmark_id: str,
    request: UpdateBookmarkRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Update a bookmark's notes or summary.

    Args:
        bookmark_id: Bookmark UUID
        request: Update data
        db: Database session

    Returns:
        BookmarkResponse with updated bookmark data
    """
    logger.info(f"=== Updating bookmark {bookmark_id} ===")

    try:
        # Convert to UUID
        bookmark_uuid = uuid.UUID(bookmark_id)

        # Query for bookmark
        query = select(Bookmark).where(Bookmark.id == bookmark_uuid)
        result = await db.execute(query)
        bookmark = result.scalar_one_or_none()

        if not bookmark:
            logger.error(f"Bookmark {bookmark_id} not found")
            raise HTTPException(status_code=404, detail=f"Bookmark {bookmark_id} not found")

        # Update fields
        if request.notes is not None:
            bookmark.notes = request.notes
            logger.info(f"Updated notes for bookmark {bookmark_id}")

        if request.turn_summary is not None:
            bookmark.turn_summary = request.turn_summary
            logger.info(f"Updated turn_summary for bookmark {bookmark_id}")

        # Commit changes
        await db.commit()
        await db.refresh(bookmark)

        logger.info(f"✅ Bookmark {bookmark_id} updated successfully")

        # Convert to response format
        return BookmarkResponse(
            id=str(bookmark.id),
            conversation_id=str(bookmark.conversation_id),
            utterance_ids=[str(uid) for uid in bookmark.utterance_ids] if bookmark.utterance_ids else None,
            turn_id=bookmark.turn_id,
            speaker_id=bookmark.speaker_id,
            turn_summary=bookmark.turn_summary,
            full_text=bookmark.full_text,
            notes=bookmark.notes,
            created_by=bookmark.created_by,
            created_at=bookmark.created_at,
            updated_at=bookmark.updated_at,
        )

    except ValueError as e:
        logger.error(f"Invalid UUID format: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid UUID format: {str(e)}")

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Failed to update bookmark: {str(e)}")
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update bookmark: {str(e)}")


@router.delete("/{bookmark_id}")
async def delete_bookmark(
    bookmark_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Delete a bookmark.

    Args:
        bookmark_id: Bookmark UUID
        db: Database session

    Returns:
        Success message
    """
    logger.info(f"=== Deleting bookmark {bookmark_id} ===")

    try:
        # Convert to UUID
        bookmark_uuid = uuid.UUID(bookmark_id)

        # Check if bookmark exists
        query = select(Bookmark).where(Bookmark.id == bookmark_uuid)
        result = await db.execute(query)
        bookmark = result.scalar_one_or_none()

        if not bookmark:
            logger.error(f"Bookmark {bookmark_id} not found")
            raise HTTPException(status_code=404, detail=f"Bookmark {bookmark_id} not found")

        # Delete bookmark
        delete_query = delete(Bookmark).where(Bookmark.id == bookmark_uuid)
        await db.execute(delete_query)
        await db.commit()

        logger.info(f"✅ Bookmark {bookmark_id} deleted successfully")

        return {
            "success": True,
            "message": f"Bookmark {bookmark_id} deleted successfully",
        }

    except ValueError as e:
        logger.error(f"Invalid UUID format: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid UUID format: {str(e)}")

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Failed to delete bookmark: {str(e)}")
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete bookmark: {str(e)}")


@router.get("/health", tags=["health"])
async def health_check():
    """Health check endpoint for bookmarks API."""
    return {
        "status": "healthy",
        "service": "bookmarks_api",
        "timestamp": datetime.now().isoformat(),
    }
