"""Transcript processing and generation API endpoints."""
import logging
from datetime import datetime
from typing import List

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from lct_python_backend.db_helpers import insert_conversation_metadata
from lct_python_backend.schemas import (
    TranscriptRequest, ChunkedTranscript, ChunkedRequest,
    SaveJsonRequest, SaveJsonResponse,
    generateFormalismRequest, generateFormalismResponse,
)
from lct_python_backend.services.gcs_helpers import save_json_to_gcs
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
async def save_json_call(request: SaveJsonRequest):
    """
    FastAPI route to save JSON data and insert metadata into the DB.
    """
    try:
        # Validate input
        if not request.file_name.strip():
            raise HTTPException(status_code=400, detail="File name cannot be empty.")

        if not isinstance(request.chunks, dict) or not isinstance(request.graph_data, list):
            raise HTTPException(status_code=400, detail="Chunks must be a valid dictionary and Graph Data must be a valid list.")

        try:
            result = save_json_to_gcs(
                request.file_name,
                request.chunks,
                request.graph_data,
                request.conversation_id
            )
        except Exception as file_error:
            raise HTTPException(status_code=500, detail=f"File saving error: {str(file_error)}")

        # Insert metadata into DB
        number_of_nodes = len(request.graph_data[0]) if request.graph_data and isinstance(request.graph_data[0], list) else 0
        print("graph data check: ", request.graph_data)
        print("number of nodes: ", len(request.graph_data[0]) if request.graph_data and isinstance(request.graph_data[0], list) else 0)
        metadata = {
            "id": result["file_id"],
            "conversation_name": result["file_name"],  # Database column is conversation_name
            "total_nodes": number_of_nodes,
            "gcs_path": result["gcs_path"],
            "created_at": datetime.utcnow()
        }
        print(f"[DEBUG] Inserting metadata: conversation_name={result['file_name']}, total_nodes={number_of_nodes}")

        await insert_conversation_metadata(metadata)

        return result

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
