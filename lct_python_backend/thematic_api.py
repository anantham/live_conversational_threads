"""Thematic analysis (hierarchical coarse-graining) API endpoints."""
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from lct_python_backend.db_session import get_async_session

logger = logging.getLogger(__name__)
router = APIRouter(tags=["thematic"])


# ============================================================================
# Background Task Helpers
# ============================================================================

async def delete_all_thematic_nodes(conversation_id: str, db: AsyncSession) -> int:
    """
    Delete all thematic nodes (levels 1-5) and their relationships for a conversation.
    Used before regenerating themes to ensure clean state.

    Returns: Total count of deleted nodes
    """
    from sqlalchemy import delete, and_, or_, select
    from lct_python_backend.models import Node, Relationship

    conv_uuid = uuid.UUID(conversation_id)

    # Get all node IDs for levels 1-5
    existing_result = await db.execute(
        select(Node.id).where(
            and_(
                Node.conversation_id == conv_uuid,
                Node.level >= 1,
                Node.level <= 5
            )
        )
    )
    node_ids = [row[0] for row in existing_result.fetchall()]

    if not node_ids:
        return 0

    # Delete relationships involving these nodes
    await db.execute(
        delete(Relationship).where(
            and_(
                Relationship.conversation_id == conv_uuid,
                or_(
                    Relationship.from_node_id.in_(node_ids),
                    Relationship.to_node_id.in_(node_ids)
                )
            )
        )
    )

    # Delete the nodes
    await db.execute(
        delete(Node).where(
            and_(
                Node.conversation_id == conv_uuid,
                Node.level >= 1,
                Node.level <= 5
            )
        )
    )

    await db.commit()
    logger.info(f"[CLEANUP] Deleted {len(node_ids)} thematic nodes for conversation {conversation_id}")
    return len(node_ids)


async def generate_hierarchical_levels_background(
    conversation_id: str,
    model: str = "anthropic/claude-3.5-sonnet",
    utterances_per_atomic_theme: int = 5,
    clustering_ratio: float = 2.5,
    force_regenerate: bool = True
):
    """
    Background task: Generate all thematic levels L5 -> L4 -> L3 -> L2 -> L1.

    Single bottom-up tree generation:
    - L5: Generate atomic themes from utterances (~1 theme per 5 utterances)
    - L4: Cluster L5 -> fine themes
    - L3: Cluster L4 -> medium themes
    - L2: Cluster L3 -> themes (major topics)
    - L1: Cluster L2 -> mega-themes (big picture)

    Args:
        conversation_id: UUID of conversation
        model: OpenRouter model ID
        utterances_per_atomic_theme: Target utterances per L5 node (default: 5)
        clustering_ratio: How many children per parent (default: 2.5)
        force_regenerate: If True, delete existing nodes first (default: True)
    """
    logger.info("=" * 50)
    logger.info(f"[BACKGROUND] === HIERARCHICAL GENERATION STARTED ===")
    logger.info(f"[BACKGROUND] conversation_id: {conversation_id}")
    logger.info(f"[BACKGROUND] model: {model}")
    logger.info(f"[BACKGROUND] utterances_per_atomic_theme: {utterances_per_atomic_theme}")
    logger.info(f"[BACKGROUND] clustering_ratio: {clustering_ratio}")
    logger.info("=" * 50)

    try:
        from lct_python_backend.db_session import get_async_session_context
        from lct_python_backend.services.hierarchical_themes import (
            Level5AtomicGenerator,
            Level4Clusterer,
            Level3Clusterer,
            Level2Clusterer,
            Level1Clusterer
        )
        from lct_python_backend.models import Utterance
        from sqlalchemy import select
        logger.info("[BACKGROUND] Imports successful")
    except Exception as e:
        logger.error(f"[BACKGROUND] Import failed: {e}", exc_info=True)
        return

    try:
        async with get_async_session_context() as db:
            # Clean up if force regenerate
            if force_regenerate:
                deleted = await delete_all_thematic_nodes(conversation_id, db)
                logger.info(f"[BACKGROUND] Cleaned up {deleted} existing nodes")

            # Fetch utterances
            result = await db.execute(
                select(Utterance).where(
                    Utterance.conversation_id == uuid.UUID(conversation_id)
                ).order_by(Utterance.sequence_number)
            )
            utterances = list(result.scalars().all())

            if not utterances:
                logger.warning(f"[BACKGROUND] No utterances found for conversation {conversation_id}")
                return

            logger.info(f"[BACKGROUND] Found {len(utterances)} utterances")

            # L5: Generate atomic themes from utterances
            logger.info("[BACKGROUND] Step 1/5: Generating Level 5 (atomic themes)...")
            l5_generator = Level5AtomicGenerator(
                db, model=model,
                utterances_per_theme=utterances_per_atomic_theme
            )
            l5_nodes = await l5_generator.get_or_generate(
                conversation_id=conversation_id,
                utterances=utterances,
                force_regenerate=False  # Already cleaned up
            )
            logger.info(f"[BACKGROUND] Level 5 complete: {len(l5_nodes)} atomic themes")

            # L4: Cluster L5 -> L4
            logger.info("[BACKGROUND] Step 2/5: Generating Level 4 (fine themes)...")
            l4_clusterer = Level4Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l4_nodes = await l4_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l5_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 4 complete: {len(l4_nodes)} fine themes")

            # L3: Cluster L4 -> L3
            logger.info("[BACKGROUND] Step 3/5: Generating Level 3 (medium themes)...")
            l3_clusterer = Level3Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l3_nodes = await l3_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l4_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 3 complete: {len(l3_nodes)} medium themes")

            # L2: Cluster L3 -> L2 (NEW - was independent before)
            logger.info("[BACKGROUND] Step 4/5: Generating Level 2 (themes)...")
            l2_clusterer = Level2Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l2_nodes = await l2_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l3_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 2 complete: {len(l2_nodes)} themes")

            # L1: Cluster L2 -> L1
            logger.info("[BACKGROUND] Step 5/5: Generating Level 1 (mega-themes)...")
            l1_clusterer = Level1Clusterer(db, model=model, clustering_ratio=clustering_ratio)
            l1_nodes = await l1_clusterer.get_or_generate(
                conversation_id=conversation_id,
                parent_nodes=l2_nodes,
                utterances=utterances,
                force_regenerate=False
            )
            logger.info(f"[BACKGROUND] Level 1 complete: {len(l1_nodes)} mega-themes")

            logger.info("=" * 50)
            logger.info(f"[BACKGROUND] === HIERARCHICAL GENERATION COMPLETE ===")
            logger.info(f"[BACKGROUND] L5: {len(l5_nodes)} | L4: {len(l4_nodes)} | L3: {len(l3_nodes)} | L2: {len(l2_nodes)} | L1: {len(l1_nodes)}")
            logger.info("=" * 50)

    except Exception as e:
        logger.error(f"[BACKGROUND] Failed to generate hierarchical levels: {e}", exc_info=True)


# ============================================================================
# Route Handlers
# ============================================================================

@router.post("/api/conversations/{conversation_id}/themes/generate")
async def generate_thematic_structure(
    conversation_id: str,
    background_tasks: BackgroundTasks,
    model: str = "anthropic/claude-3.5-sonnet",
    utterances_per_atomic_theme: int = 5,
    clustering_ratio: float = 2.5,
    force_regenerate: bool = True,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Generate thematic structure for a conversation using AI.

    Kicks off background generation of all hierarchical levels:
    L5 (atomic) -> L4 (fine) -> L3 (medium) -> L2 (themes) -> L1 (mega)

    All levels form a single coherent tree where each level clusters its children.

    Args:
        conversation_id: UUID of conversation
        model: OpenRouter model ID (default claude-3.5-sonnet)
        utterances_per_atomic_theme: Target utterances per L5 node (default: 5)
        clustering_ratio: How many children per parent node (default: 2.5)
        force_regenerate: Delete existing themes and regenerate (default: True)

    Returns:
        {
            "status": "generating",
            "message": "Background generation started",
            "levels_generating": [5, 4, 3, 2, 1],
            "config": {...}
        }
    """
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Utterance

        # Validate conversation exists
        conv_result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = conv_result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        # Check utterance count
        utt_result = await db.execute(
            select(func.count(Utterance.id)).where(
                Utterance.conversation_id == uuid.UUID(conversation_id)
            )
        )
        utterance_count = utt_result.scalar()

        if utterance_count == 0:
            raise HTTPException(status_code=400, detail="Conversation has no utterances")

        # Kick off background task
        background_tasks.add_task(
            generate_hierarchical_levels_background,
            conversation_id=conversation_id,
            model=model,
            utterances_per_atomic_theme=utterances_per_atomic_theme,
            clustering_ratio=clustering_ratio,
            force_regenerate=force_regenerate
        )

        logger.info(f"[GENERATE] Started background generation for {conversation_id}")

        return {
            "status": "generating",
            "message": "Background generation started for all hierarchical levels",
            "levels_generating": [5, 4, 3, 2, 1],
            "utterance_count": utterance_count,
            "config": {
                "model": model,
                "utterances_per_atomic_theme": utterances_per_atomic_theme,
                "clustering_ratio": clustering_ratio,
                "force_regenerate": force_regenerate
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ERROR] Failed to start thematic generation: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/themes")
async def get_thematic_structure(
    conversation_id: str,
    level: Optional[int] = 2,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Get existing thematic structure for a conversation at a specific level

    Args:
        conversation_id: UUID of conversation
        level: Which hierarchical level to fetch (0-5, default 2)
            - 0: Utterances (raw transcript)
            - 1: Mega-themes (3-5 nodes)
            - 2: Themes (10-15 nodes) - default
            - 3: Medium detail (20-30 nodes)
            - 4: Fine detail (40-60 nodes)
            - 5: Atomic themes (60-120 nodes)

    Returns thematic nodes and edges if they exist, otherwise empty.
    """
    try:
        from lct_python_backend.services.thematic_analyzer import ThematicAnalyzer
        from lct_python_backend.models import Node, Relationship, Utterance
        from sqlalchemy import select, and_

        conv_uuid = uuid.UUID(conversation_id)

        # Validate level
        if level not in [0, 1, 2, 3, 4, 5]:
            raise HTTPException(status_code=400, detail="Level must be 0, 1, 2, 3, 4, or 5")

        # Level 0: Return utterances as nodes
        if level == 0:
            result = await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conv_uuid)
                .order_by(Utterance.sequence_number)
            )
            utterances = result.scalars().all()

            # Format utterances as thematic nodes for consistent display
            thematic_nodes = []
            for utt in utterances:
                thematic_nodes.append({
                    "id": str(utt.id),
                    "label": f"[{utt.sequence_number}] {utt.speaker_name or utt.speaker_id}",
                    "summary": utt.text[:500] if utt.text else "",
                    "node_type": "utterance",
                    "utterance_ids": [str(utt.id)],
                    "timestamp_start": utt.timestamp_start,
                    "timestamp_end": utt.timestamp_end,
                })

            # Create sequential edges between consecutive utterances
            edges = []
            for i in range(len(thematic_nodes) - 1):
                edges.append({
                    "source": thematic_nodes[i]["id"],
                    "target": thematic_nodes[i + 1]["id"],
                    "type": "follows",
                })

            return {
                "thematic_nodes": thematic_nodes,
                "edges": edges,
                "summary": {
                    "total_themes": len(thematic_nodes),
                    "exists": True,
                    "level": 0,
                    "description": "Raw utterances"
                }
            }

        # Fetch nodes for requested level (1-5)
        result = await db.execute(
            select(Node).where(
                and_(
                    Node.conversation_id == conv_uuid,
                    Node.level == level
                )
            )
        )
        nodes = result.scalars().all()

        if not nodes:
            return {
                "thematic_nodes": [],
                "edges": [],
                "summary": {
                    "total_themes": 0,
                    "exists": False,
                    "level": level
                }
            }

        # Serialize existing structure
        analyzer = ThematicAnalyzer(db)
        structure = await analyzer._serialize_existing_structure(nodes, conversation_id)
        structure["summary"]["exists"] = True
        structure["summary"]["level"] = level

        return structure

    except Exception as e:
        print(f"[ERROR] Failed to get thematic structure: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/themes/levels")
async def get_available_levels(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Check which hierarchical levels have been generated for this conversation

    Used by frontend to poll for availability of levels during background generation.

    Returns:
        {
            "available_levels": [2, 5],  # Levels that exist
            "generating": [1, 3, 4],     # Levels presumably being generated
            "level_counts": {
                "1": 0,
                "2": 12,
                "3": 0,
                "4": 0,
                "5": 87
            }
        }
    """
    try:
        from lct_python_backend.models import Node, Utterance
        from sqlalchemy import select, and_

        conv_uuid = uuid.UUID(conversation_id)

        # Query for count of nodes at each level (1-5)
        result = await db.execute(
            select(
                Node.level,
                func.count(Node.id).label('count')
            ).where(
                Node.conversation_id == conv_uuid
            ).group_by(Node.level)
        )

        level_counts = {row.level: row.count for row in result}

        # Query for utterance count (Level 0)
        utt_result = await db.execute(
            select(func.count(Utterance.id)).where(
                Utterance.conversation_id == conv_uuid
            )
        )
        utterance_count = utt_result.scalar() or 0

        # Add Level 0 (utterances) to counts
        level_counts[0] = utterance_count

        # Determine available levels (those with nodes)
        # Level 0 is always available if there are utterances
        available_levels = sorted([level for level, count in level_counts.items() if count > 0])

        # Infer which levels are being generated
        # If L5 exists but not all levels 1-5, assume background generation is in progress
        thematic_levels = [1, 2, 3, 4, 5]
        thematic_available = [l for l in available_levels if l in thematic_levels]
        if 5 in thematic_available and set(thematic_available) != set(thematic_levels):
            generating = [level for level in thematic_levels if level not in thematic_available]
        else:
            generating = []

        return {
            "available_levels": available_levels,
            "generating": generating,
            "level_counts": {str(k): v for k, v in level_counts.items()}
        }

    except Exception as e:
        print(f"[ERROR] Failed to get available levels: {e}")
        raise HTTPException(status_code=500, detail=str(e))
