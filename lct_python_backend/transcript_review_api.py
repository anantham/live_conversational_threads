"""Private owner transcript review using existing utterance/edit storage."""

from uuid import UUID
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field
from lct_python_backend.attendee_source_api import require_source_auth
from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.owner_context import get_current_owner_id
from lct_python_backend.services.transcript_review import (
    read_transcript,
    correct_utterance,
)

router = APIRouter(dependencies=[Depends(require_source_auth)])


class TextCorrection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_text: str = Field(max_length=100000)
    text: str = Field(min_length=1, max_length=100000)


@router.get("/api/conversations/{conversation_id}/transcript-review")
async def transcript_review(
    conversation_id: UUID, response: Response, db=Depends(get_async_session)
):
    response.headers["Cache-Control"] = "private, no-store"
    return await read_transcript(
        db, conversation_id=conversation_id, owner_id=get_current_owner_id()
    )


@router.patch("/api/conversations/{conversation_id}/utterances/{utterance_id}/text")
async def patch_text(
    conversation_id: UUID,
    utterance_id: UUID,
    body: TextCorrection,
    response: Response,
    db=Depends(get_async_session),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await correct_utterance(
        db,
        conversation_id=conversation_id,
        utterance_id=utterance_id,
        owner_id=get_current_owner_id(),
        **body.model_dump(),
    )
