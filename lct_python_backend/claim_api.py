"""
API endpoints for Three-Layer Claim Detection

Handles claim analysis, retrieval, and search.
"""

from fastapi import HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional, List
import uuid

from models import Claim
from services.claim_detector import ClaimDetector


async def analyze_conversation_claims(
    conversation_id: str,
    force_reanalysis: bool = False,
    db: AsyncSession = None
):
    """
    Analyze conversation for factual, normative, and worldview claims.

    Args:
        conversation_id: UUID of conversation
        force_reanalysis: If True, re-analyze even if claims exist
        db: Database session

    Returns:
        {
            "conversation_id": str,
            "total_claims": int,
            "by_type": {"factual": int, "normative": int, "worldview": int},
            "by_speaker": {...},
            "claims": [...]
        }
    """
    detector = ClaimDetector(db)

    try:
        result = await detector.analyze_conversation(conversation_id, force_reanalysis)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error analyzing claims: {str(e)}")


async def get_conversation_claims(
    conversation_id: str,
    claim_type: Optional[str] = None,
    speaker: Optional[str] = None,
    db: AsyncSession = None
):
    """
    Get all claims for a conversation with optional filters.

    Args:
        conversation_id: UUID of conversation
        claim_type: Filter by type ('factual', 'normative', 'worldview')
        speaker: Filter by speaker name
        db: Database session

    Returns:
        {
            "conversation_id": str,
            "count": int,
            "claims": [...]
        }
    """
    query = select(Claim).where(Claim.conversation_id == uuid.UUID(conversation_id))

    if claim_type:
        if claim_type not in ['factual', 'normative', 'worldview']:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid claim_type. Must be 'factual', 'normative', or 'worldview'"
            )
        query = query.where(Claim.claim_type == claim_type)

    if speaker:
        query = query.where(Claim.speaker_name == speaker)

    result = await db.execute(query)
    claims = result.scalars().all()

    return {
        "conversation_id": conversation_id,
        "count": len(claims),
        "filters": {
            "claim_type": claim_type,
            "speaker": speaker
        },
        "claims": [_claim_to_dict(c) for c in claims]
    }


async def get_claim_details(
    claim_id: str,
    db: AsyncSession = None
):
    """
    Get detailed information about a specific claim.

    Args:
        claim_id: UUID of claim
        db: Database session

    Returns:
        Claim details with related claims
    """
    query = select(Claim).where(Claim.id == uuid.UUID(claim_id))
    result = await db.execute(query)
    claim = result.scalar_one_or_none()

    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    # Get related claims (supports/contradicts)
    supports = []
    contradicts = []

    if claim.supports_claim_ids:
        supports_query = select(Claim).where(Claim.id.in_(claim.supports_claim_ids))
        supports_result = await db.execute(supports_query)
        supports = supports_result.scalars().all()

    if claim.contradicts_claim_ids:
        contradicts_query = select(Claim).where(Claim.id.in_(claim.contradicts_claim_ids))
        contradicts_result = await db.execute(contradicts_query)
        contradicts = contradicts_result.scalars().all()

    return {
        **_claim_to_dict(claim),
        "supports": [_claim_to_dict(c) for c in supports],
        "contradicts": [_claim_to_dict(c) for c in contradicts],
    }


async def get_claims_by_node(
    node_id: str,
    db: AsyncSession = None
):
    """
    Get all claims for a specific node.

    Args:
        node_id: UUID of node
        db: Database session

    Returns:
        List of claims for this node
    """
    query = select(Claim).where(Claim.node_id == uuid.UUID(node_id))
    result = await db.execute(query)
    claims = result.scalars().all()

    return {
        "node_id": node_id,
        "count": len(claims),
        "claims": [_claim_to_dict(c) for c in claims]
    }


def _claim_to_dict(claim: Claim) -> dict:
    """Convert Claim model to dict."""
    return {
        "id": str(claim.id),
        "conversation_id": str(claim.conversation_id),
        "node_id": str(claim.node_id),
        "claim_text": claim.claim_text,
        "claim_type": claim.claim_type,
        "speaker_name": claim.speaker_name,
        "strength": claim.strength,
        "confidence": claim.confidence,
        # Factual
        "is_verifiable": claim.is_verifiable,
        "verification_status": claim.verification_status,
        # Normative
        "normative_type": claim.normative_type,
        "implicit_values": claim.implicit_values,
        # Worldview
        "worldview_category": claim.worldview_category,
        "hidden_premises": claim.hidden_premises,
        "ideological_markers": claim.ideological_markers,
        # Metadata
        "analyzed_at": claim.analyzed_at.isoformat() if claim.analyzed_at else None,
    }
