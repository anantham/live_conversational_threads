"""
API endpoints for Argument Mapping & Is-Ought Conflation Detection

Handles argument tree analysis and naturalistic fallacy detection.
"""

from fastapi import HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional, List
import uuid

from models import ArgumentTree, IsOughtConflation, Claim
from services.argument_mapper import ArgumentMapper
from services.is_ought_detector import IsOughtDetector


async def analyze_node_arguments(
    node_id: str,
    force_reanalysis: bool = False,
    db: AsyncSession = None
):
    """
    Analyze a node for argument structures (premise → conclusion).

    Args:
        node_id: UUID of node
        force_reanalysis: If True, re-analyze even if tree exists
        db: Database session

    Returns:
        Argument tree data or None if no argument found
    """
    mapper = ArgumentMapper(db)

    try:
        result = await mapper.analyze_node(node_id, force_reanalysis)

        if result is None:
            return {
                "node_id": node_id,
                "has_argument": False,
                "message": "No argument structure found (need at least 2 claims)"
            }

        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error analyzing arguments: {str(e)}")


async def get_conversation_argument_trees(
    conversation_id: str,
    db: AsyncSession = None
):
    """
    Get all argument trees for a conversation.

    Args:
        conversation_id: UUID of conversation
        db: Database session

    Returns:
        List of argument trees
    """
    query = select(ArgumentTree).where(
        ArgumentTree.conversation_id == uuid.UUID(conversation_id)
    )

    result = await db.execute(query)
    trees = result.scalars().all()

    return {
        "conversation_id": conversation_id,
        "count": len(trees),
        "argument_trees": [_argument_tree_to_dict(tree) for tree in trees]
    }


async def get_argument_tree_details(
    tree_id: str,
    db: AsyncSession = None
):
    """
    Get detailed information about a specific argument tree.

    Args:
        tree_id: UUID of argument tree
        db: Database session

    Returns:
        Argument tree details with claims
    """
    query = select(ArgumentTree).where(ArgumentTree.id == uuid.UUID(tree_id))
    result = await db.execute(query)
    tree = result.scalar_one_or_none()

    if not tree:
        raise HTTPException(status_code=404, detail="Argument tree not found")

    # Get premise claims
    premises = []
    if tree.premise_claim_ids:
        premises_query = select(Claim).where(Claim.id.in_(tree.premise_claim_ids))
        premises_result = await db.execute(premises_query)
        premises = premises_result.scalars().all()

    # Get conclusion claims
    conclusions = []
    if tree.conclusion_claim_ids:
        conclusions_query = select(Claim).where(Claim.id.in_(tree.conclusion_claim_ids))
        conclusions_result = await db.execute(conclusions_query)
        conclusions = conclusions_result.scalars().all()

    return {
        **_argument_tree_to_dict(tree),
        "premise_claims": [_claim_summary(c) for c in premises],
        "conclusion_claims": [_claim_summary(c) for c in conclusions]
    }


async def analyze_conversation_is_ought(
    conversation_id: str,
    confidence_threshold: float = 0.7,
    db: AsyncSession = None
):
    """
    Analyze conversation for is-ought conflations (naturalistic fallacies).

    Args:
        conversation_id: UUID of conversation
        confidence_threshold: Minimum confidence to include (0-1)
        db: Database session

    Returns:
        {
            "conversation_id": str,
            "total_conflations": int,
            "conflations": [...]
        }
    """
    detector = IsOughtDetector(db)

    try:
        result = await detector.analyze_conversation(
            conversation_id,
            confidence_threshold
        )
        return result
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error analyzing is-ought conflations: {str(e)}"
        )


async def get_conversation_is_ought_conflations(
    conversation_id: str,
    min_strength: Optional[float] = None,
    db: AsyncSession = None
):
    """
    Get all is-ought conflations for a conversation.

    Args:
        conversation_id: UUID of conversation
        min_strength: Optional minimum strength threshold (0-1)
        db: Database session

    Returns:
        List of is-ought conflations
    """
    query = select(IsOughtConflation).where(
        IsOughtConflation.conversation_id == uuid.UUID(conversation_id)
    )

    if min_strength is not None:
        query = query.where(IsOughtConflation.strength >= min_strength)

    result = await db.execute(query)
    conflations = result.scalars().all()

    return {
        "conversation_id": conversation_id,
        "count": len(conflations),
        "filters": {
            "min_strength": min_strength
        },
        "conflations": [_conflation_to_dict(c) for c in conflations]
    }


async def get_conflation_details(
    conflation_id: str,
    db: AsyncSession = None
):
    """
    Get detailed information about a specific is-ought conflation.

    Args:
        conflation_id: UUID of conflation
        db: Database session

    Returns:
        Conflation details with full claims
    """
    query = select(IsOughtConflation).where(
        IsOughtConflation.id == uuid.UUID(conflation_id)
    )
    result = await db.execute(query)
    conflation = result.scalar_one_or_none()

    if not conflation:
        raise HTTPException(status_code=404, detail="Conflation not found")

    # Get descriptive claim
    descriptive_query = select(Claim).where(
        Claim.id == conflation.descriptive_claim_id
    )
    descriptive_result = await db.execute(descriptive_query)
    descriptive_claim = descriptive_result.scalar_one_or_none()

    # Get normative claim
    normative_query = select(Claim).where(
        Claim.id == conflation.normative_claim_id
    )
    normative_result = await db.execute(normative_query)
    normative_claim = normative_result.scalar_one_or_none()

    return {
        **_conflation_to_dict(conflation),
        "descriptive_claim": _claim_summary(descriptive_claim) if descriptive_claim else None,
        "normative_claim": _claim_summary(normative_claim) if normative_claim else None
    }


async def get_node_is_ought_conflations(
    node_id: str,
    db: AsyncSession = None
):
    """
    Get all is-ought conflations for a specific node.

    Args:
        node_id: UUID of node
        db: Database session

    Returns:
        List of conflations for this node
    """
    query = select(IsOughtConflation).where(
        IsOughtConflation.node_id == uuid.UUID(node_id)
    )
    result = await db.execute(query)
    conflations = result.scalars().all()

    return {
        "node_id": node_id,
        "count": len(conflations),
        "conflations": [_conflation_to_dict(c) for c in conflations]
    }


# Helper functions

def _argument_tree_to_dict(tree: ArgumentTree) -> dict:
    """Convert ArgumentTree model to dict."""
    return {
        "id": str(tree.id),
        "conversation_id": str(tree.conversation_id),
        "node_id": str(tree.node_id),
        "root_claim_id": str(tree.root_claim_id) if tree.root_claim_id else None,
        "tree_structure": tree.tree_structure,
        "title": tree.title,
        "summary": tree.summary,
        "argument_type": tree.argument_type,
        "is_valid": tree.is_valid,
        "is_sound": tree.is_sound,
        "confidence": tree.confidence,
        "identified_fallacies": tree.identified_fallacies,
        "circular_dependencies": [str(cid) for cid in (tree.circular_dependencies or [])],
        "premise_claim_ids": [str(cid) for cid in (tree.premise_claim_ids or [])],
        "conclusion_claim_ids": [str(cid) for cid in (tree.conclusion_claim_ids or [])],
        "visualization_data": tree.visualization_data,
        "created_at": tree.created_at.isoformat() if tree.created_at else None
    }


def _conflation_to_dict(conflation: IsOughtConflation) -> dict:
    """Convert IsOughtConflation model to dict."""
    return {
        "id": str(conflation.id),
        "conversation_id": str(conflation.conversation_id),
        "node_id": str(conflation.node_id),
        "descriptive_claim_id": str(conflation.descriptive_claim_id),
        "normative_claim_id": str(conflation.normative_claim_id),
        "fallacy_type": conflation.fallacy_type,
        "explanation": conflation.explanation,
        "strength": conflation.strength,
        "confidence": conflation.confidence,
        "conflation_text": conflation.conflation_text,
        "utterance_ids": [str(uid) for uid in (conflation.utterance_ids or [])],
        "speaker_name": conflation.speaker_name,
        "detected_at": conflation.detected_at.isoformat() if conflation.detected_at else None
    }


def _claim_summary(claim: Claim) -> dict:
    """Convert Claim to summary dict."""
    return {
        "id": str(claim.id),
        "claim_text": claim.claim_text,
        "claim_type": claim.claim_type,
        "speaker_name": claim.speaker_name,
        "strength": claim.strength,
        "confidence": claim.confidence
    }
