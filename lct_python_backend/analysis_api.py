"""Simulacra, bias, and frame detection API endpoints (Weeks 11-13)."""
import logging
from fastapi import APIRouter, HTTPException

from lct_python_backend.db_session import get_async_session_context

logger = logging.getLogger(__name__)
router = APIRouter(tags=["analysis"])


# ============================================================================
# Week 11: Simulacra Level Detection
# ============================================================================

@router.post("/api/conversations/{conversation_id}/simulacra/analyze")
async def analyze_simulacra_levels(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for Simulacra levels

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns distribution and per-node analysis
    """
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Simulacra analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/simulacra")
async def get_simulacra_results(conversation_id: str):
    """Get existing Simulacra analysis results for a conversation"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get Simulacra results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/nodes/{node_id}/simulacra")
async def get_node_simulacra(node_id: str):
    """Get Simulacra analysis for a specific node"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.simulacra_detector import SimulacraDetector

            detector = SimulacraDetector(session)
            result = await detector.get_node_simulacra(node_id)

            if result is None:
                raise HTTPException(
                    status_code=404,
                    detail="No Simulacra analysis found for this node"
                )

            return result

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to get node Simulacra: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Week 12: Cognitive Bias Detection
# ============================================================================

@router.post("/api/conversations/{conversation_id}/biases/analyze")
async def analyze_cognitive_biases(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for cognitive biases

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns bias distribution and per-node analysis
    """
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Bias analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/biases")
async def get_bias_results(conversation_id: str):
    """Get existing cognitive bias analysis results for a conversation"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get bias results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/nodes/{node_id}/biases")
async def get_node_biases(node_id: str):
    """Get cognitive bias analyses for a specific node"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.bias_detector import BiasDetector

            detector = BiasDetector(session)
            biases = await detector.get_node_biases(node_id)

            return {"biases": biases}

    except Exception as e:
        print(f"[ERROR] Failed to get node biases: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Week 13: Implicit Frame Detection
# ============================================================================

@router.post("/api/conversations/{conversation_id}/frames/analyze")
async def analyze_implicit_frames(
    conversation_id: str,
    force_reanalysis: bool = False
):
    """
    Analyze all nodes in a conversation for implicit frames

    Query params:
        force_reanalysis: Re-analyze even if already analyzed

    Returns frame distribution and per-node analysis
    """
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            results = await detector.analyze_conversation(
                conversation_id,
                force_reanalysis=force_reanalysis
            )

            return results

    except Exception as e:
        print(f"[ERROR] Frame analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/frames")
async def get_frame_results(conversation_id: str):
    """Get existing implicit frame analysis results for a conversation"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            results = await detector.get_conversation_results(conversation_id)

            return results

    except Exception as e:
        print(f"[ERROR] Failed to get frame results: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/nodes/{node_id}/frames")
async def get_node_frames(node_id: str):
    """Get implicit frame analyses for a specific node"""
    try:
        async with get_async_session_context() as session:
            from lct_python_backend.services.frame_detector import FrameDetector

            detector = FrameDetector(session)
            frames = await detector.get_node_frames(node_id)

            return {"frames": frames}

    except Exception as e:
        print(f"[ERROR] Failed to get node frames: {e}")
        raise HTTPException(status_code=500, detail=str(e))
