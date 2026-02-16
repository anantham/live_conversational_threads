"""Transcript processing and generation API endpoints."""
import logging
import os
import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation
from lct_python_backend.schemas import (
    TranscriptRequest, ChunkedTranscript, ChunkedRequest,
    SaveJsonRequest, SaveJsonResponse,
    generateFormalismRequest, generateFormalismResponse,
)
from lct_python_backend.services.gcs_helpers import save_json_with_backend
from lct_python_backend.services.llm_helpers import (
    sliding_window_chunking, stream_generate_context_json, generate_formalism,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["generation"])


@router.post("/get_chunks/", response_model=ChunkedTranscript)
async def get_chunks(request: TranscriptRequest):
    try:
        transcript = request.transcript

        if not transcript:
            raise HTTPException(status_code=400, detail="Transcript must be a non-empty string.")

        chunks = sliding_window_chunking(transcript)

        if not chunks:
            raise HTTPException(status_code=500, detail="Chunking failed. No chunks were generated.")

        return ChunkedTranscript(chunks=chunks)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")


@router.post("/generate-context-stream/")
async def generate_context_stream(request: ChunkedRequest):
    try:
        chunks = request.chunks

        if not chunks or not isinstance(chunks, dict):
            raise HTTPException(status_code=400, detail="Chunks must be a non-empty dictionary.")

        return StreamingResponse(stream_generate_context_json(chunks), media_type="application/json")

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")


@router.post("/save_json/", response_model=SaveJsonResponse)
async def save_json_call(
    request: SaveJsonRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Save graph JSON to storage and update conversation metadata in DB."""
    try:
        if not request.file_name.strip():
            raise HTTPException(status_code=400, detail="File name cannot be empty.")

        if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, list):
            raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")

        save_backend = str(os.getenv("SAVE_BACKEND", "auto")).strip().lower()
        if save_backend not in {"auto", "gcs", "local"}:
            logger.warning("Invalid SAVE_BACKEND '%s'; defaulting to auto", save_backend)
            save_backend = "auto"

        try:
            result = save_json_with_backend(
                request.file_name,
                request.chunks,
                request.graph_data,
                request.conversation_id,
                backend=save_backend,
            )
        except ValueError as file_error:
            raise HTTPException(status_code=400, detail=f"File saving config error: {str(file_error)}")
        except Exception as file_error:
            raise HTTPException(status_code=500, detail=f"File saving error: {str(file_error)}")

        # Count nodes
        number_of_nodes = 0
        if request.graph_data and isinstance(request.graph_data[0], list):
            number_of_nodes = len(request.graph_data[0])
        elif request.graph_data and isinstance(request.graph_data[0], dict):
            number_of_nodes = len(request.graph_data)

        # Update existing conversation row (created by ensure_conversation during
        # WebSocket session), or create one if it doesn't exist yet.
        conv_uuid = uuid.UUID(result["file_id"])
        conv = await db.get(Conversation, conv_uuid)

        if conv:
            conv.conversation_name = result["file_name"]
            conv.total_nodes = number_of_nodes
            conv.gcs_path = result.get("gcs_path")
            conv.updated_at = datetime.utcnow()
        else:
            conv = Conversation(
                id=conv_uuid,
                conversation_name=result["file_name"],
                conversation_type="live_audio",
                source_type="save_json",
                owner_id="default_user",
                started_at=datetime.utcnow(),
                total_nodes=number_of_nodes,
                gcs_path=result.get("gcs_path"),
            )
            db.add(conv)

        await db.commit()

        logger.info(
            "Persisted conversation: name=%s nodes=%s storage=%s existing=%s",
            result["file_name"],
            number_of_nodes,
            result.get("storage", "unknown"),
            conv.started_at is not None,
        )

        return {
            "message": result.get("message", "Saved!"),
            "file_id": result["file_id"],
            "file_name": result["file_name"],
        }

    except HTTPException as http_err:
        raise http_err

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")


@router.post("/generate_formalism/", response_model=generateFormalismResponse)
async def generate_formalism_call(request: generateFormalismRequest):
    try:
        # Validate input data
        if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, List):
            raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")
        try:
            result = generate_formalism(request.chunks, request.graph_data, request.user_pref) # save json function
        except Exception as formalism_error:
            print(f"[INFO]: Formalism Generation error: {formalism_error}")
            raise HTTPException(status_code=500, detail=f"Formalism Generation error: {str(formalism_error)}")

        return {"formalism_data": result}

    except HTTPException as http_err:
        raise http_err  # Re-raise HTTP exceptions as they are

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")
