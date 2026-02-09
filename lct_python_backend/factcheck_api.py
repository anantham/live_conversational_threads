"""Fact-check, audio download, and cost tracking API endpoints."""
import logging
from typing import Optional
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from lct_python_backend.config import AUDIO_RECORDINGS_DIR, AUDIO_DOWNLOAD_TOKEN
from lct_python_backend.schemas import ClaimsResponse, FactCheckRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["factcheck"])


@router.post("/fact_check_claims/", response_model=ClaimsResponse)
async def fact_check_claims_call(request: FactCheckRequest):
    try:
        if not request.claims:
            raise HTTPException(status_code=400, detail="No claims provided.")

        result = generate_fact_check_json_perplexity(request.claims)
        if result is None:
            raise HTTPException(status_code=500, detail="Fact-checking service failed.")

        return result

    except HTTPException as http_err:
        raise http_err
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")


# Download recorded audio (token gated)
@router.get("/api/conversations/{conversation_id}/audio")
async def download_audio(conversation_id: str, token: Optional[str] = Query(None)):
    if AUDIO_DOWNLOAD_TOKEN and token != AUDIO_DOWNLOAD_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing token")

    wav_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.wav"
    flac_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.flac"

    if wav_path.exists():
        return FileResponse(wav_path, media_type="audio/wav", filename=wav_path.name)
    if flac_path.exists():
        return FileResponse(flac_path, media_type="audio/flac", filename=flac_path.name)

    raise HTTPException(status_code=404, detail="Recording not found")


@router.get("/api/cost-tracking/stats")
async def get_cost_stats(time_range: str = "7d"):
    """
    Get API cost statistics

    Query params:
        time_range: 1d, 7d, 30d, or all

    Returns aggregated cost data by feature, model, and time
    """
    try:
        # Mock data for now - in production this would query api_calls_log table
        # TODO: Implement real database queries when api_calls_log is populated

        mock_data = {
            "total_cost": 12.45,
            "total_calls": 450,
            "total_tokens": 125000,
            "avg_cost_per_call": 0.0277,
            "avg_tokens_per_call": 278,
            "conversations_analyzed": 15,
            "by_feature": {
                "simulacra_detection": {
                    "cost": 3.20,
                    "calls": 150,
                    "tokens": 40000
                },
                "bias_detection": {
                    "cost": 4.50,
                    "calls": 150,
                    "tokens": 45000
                },
                "frame_detection": {
                    "cost": 4.75,
                    "calls": 150,
                    "tokens": 40000
                }
            },
            "by_model": {
                "claude-3-5-sonnet-20241022": {
                    "cost": 12.45,
                    "calls": 450,
                    "tokens": 125000
                }
            },
            "recent_calls": [
                {
                    "timestamp": "2025-11-12T12:30:00Z",
                    "endpoint": "frame_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 350,
                    "cost_usd": 0.035,
                    "latency_ms": 2500
                },
                {
                    "timestamp": "2025-11-12T12:25:00Z",
                    "endpoint": "bias_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 280,
                    "cost_usd": 0.028,
                    "latency_ms": 2100
                },
                {
                    "timestamp": "2025-11-12T12:20:00Z",
                    "endpoint": "simulacra_detection",
                    "model": "claude-3-5-sonnet-20241022",
                    "total_tokens": 200,
                    "cost_usd": 0.020,
                    "latency_ms": 1800
                }
            ]
        }

        return mock_data

    except Exception as e:
        print(f"[ERROR] Failed to get cost stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))
