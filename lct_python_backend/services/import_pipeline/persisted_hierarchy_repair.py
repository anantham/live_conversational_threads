"""Transactional repair of an already-persisted transcript hierarchy."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from sqlalchemy import select

from lct_python_backend.models import Conversation
from lct_python_backend.services.conversation_reader import (
    build_graph_data_from_nodes,
    fetch_conversation_bundle,
)
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.deployment_privacy_policy import (
    select_providers_for_privacy,
)
from lct_python_backend.services.hierarchy_consolidator import (
    consolidate_ideas_to_topics,
    consolidate_themes_to_arcs,
    consolidate_topics_to_themes,
)
from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    clean_faithful_edges,
    node_id,
    node_level,
    synchronize_hierarchy_best_effort,
    uses_faithful_edge_representation,
)
from lct_python_backend.services.import_pipeline.hierarchy_audit import (
    audit_hierarchy,
)
from lct_python_backend.services.import_pipeline.import_hierarchy_repair import (
    repair_chunk_idea_hierarchy,
)
from lct_python_backend.services.llm_config import (
    load_llm_providers,
)
from lct_python_backend.services.owner_context import resolve_owner_id
from lct_python_backend.services.transcript.transcript_identity import (
    canonicalize_batch_node_ids,
)
from lct_python_backend.services.tuning_constants import (
    MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
    MIN_THEMES_FOR_ARC_CONSOLIDATION,
    MIN_TOPICS_FOR_THEME_CONSOLIDATION,
)

logger = logging.getLogger("lct_backend")


async def _resolve_conversation(
    db,
    *,
    conversation_id: Optional[str],
    group_id: Optional[str],
    owner_id: str,
) -> Conversation:
    if not conversation_id and not group_id:
        raise ValueError("repair requires either conversation_id or group_id")
    owner = resolve_owner_id(owner_id)
    conversation = None
    if conversation_id:
        try:
            conversation_uuid = uuid.UUID(str(conversation_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError("conversation_id must be a UUID") from exc
        conversation = (
            await db.execute(
                select(Conversation).where(Conversation.id == conversation_uuid)
            )
        ).scalar_one_or_none()
    if conversation is None and group_id:
        conversation = (
            await db.execute(
                select(Conversation).where(
                    Conversation.owner_id == owner,
                    Conversation.indrasnet_group_id == group_id,
                    Conversation.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    if conversation is None:
        raise ValueError("conversation to repair was not found")
    if conversation.owner_id != owner:
        raise ValueError("conversation does not belong to this owner")
    if conversation.deleted_at is not None:
        raise ValueError("conversation is deleted")
    return conversation


def _assert_unique_ids(nodes: list[Dict[str, Any]]) -> None:
    ids = [node_id(node) for node in nodes]
    if any(not value for value in ids):
        raise ValueError("Repaired hierarchy contains a node without an id")
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        raise ValueError(
            f"Repaired hierarchy contains {len(duplicates)} duplicate node ids"
        )


def _assert_turn_coverage(nodes, utterances) -> int:
    expected = {str(utterance.id) for utterance in utterances}
    covered = {
        str(utterance_id)
        for node in nodes
        if node_level(node) <= 2
        for utterance_id in (node.get("utterance_ids") or [])
    }
    dangling = covered - expected
    missing = expected - covered
    if dangling or missing:
        raise ValueError(
            "Repaired hierarchy failed turn coverage: "
            f"missing={len(missing)}, dangling={len(dangling)}"
        )
    return len(covered)


async def repair_persisted_hierarchy(
    db,
    *,
    conversation_id: Optional[str] = None,
    group_id: Optional[str] = None,
    owner_id: str = "anonymous",
) -> Dict[str, Any]:
    """Repair L1->L2, best-effort upper tiers, then atomically re-materialize."""

    conversation = await _resolve_conversation(
        db,
        conversation_id=conversation_id,
        group_id=group_id,
        owner_id=owner_id,
    )
    conversation_id = str(conversation.id)
    conversation, db_nodes, relationships, utterances = await fetch_conversation_bundle(
        db, conversation.id
    )
    if not db_nodes or not utterances:
        raise ValueError("conversation must have persisted graph nodes and turns")

    graph = build_graph_data_from_nodes(
        db_nodes,
        relationships,
        utterances=utterances,
        include_edges_out=True,
    )
    base_nodes = [node for node in graph if node_level(node) <= 2]
    if not base_nodes:
        raise ValueError("conversation has no level-1/level-2 graph to repair")

    materialize_membership_edges = uses_faithful_edge_representation(base_nodes)
    edge_stats = clean_faithful_edges(base_nodes)
    providers_config = await load_llm_providers(db, include_secrets=True)
    configured_providers = (
        providers_config.get("providers")
        if isinstance(providers_config, dict)
        else []
    ) or []
    metadata = dict(conversation.source_metadata or {})
    privacy = metadata.get("privacy") if isinstance(metadata.get("privacy"), dict) else None
    providers = select_providers_for_privacy(configured_providers, privacy)
    logger.info(
        "[HIERARCHY REPAIR][privacy] local_llm_ok=%s external_llm_ok=%s provider_ids=%s",
        bool(privacy and privacy.get("local_llm_ok") is True),
        bool(privacy and privacy.get("external_llm_ok") is True),
        [str(provider.get("id") or "unnamed") for provider in providers],
    )

    repair_stats = await repair_chunk_idea_hierarchy(
        base_nodes,
        providers=providers,
    )
    ideas = [node for node in base_nodes if node_level(node) == 2]
    topics = []
    themes = []
    arcs = []
    title = ""
    summary = ""
    try:
        if len(ideas) >= MIN_IDEAS_FOR_TOPIC_CONSOLIDATION:
            generated_topics = await consolidate_ideas_to_topics(
                ideas, providers=providers
            )
            if generated_topics:
                topics = canonicalize_batch_node_ids(
                    generated_topics, existing_nodes=base_nodes
                )
            else:
                logger.warning(
                    "[HIERARCHY REPAIR] topic consolidation returned no nodes; "
                    "persisting the complete L1-L2 repair"
                )

        if len(topics) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
            generated_themes = await consolidate_topics_to_themes(
                topics, providers=providers
            )
            if generated_themes:
                themes = canonicalize_batch_node_ids(
                    generated_themes,
                    existing_nodes=[*base_nodes, *topics],
                )
            else:
                logger.warning(
                    "[HIERARCHY REPAIR] theme consolidation returned no nodes; "
                    "persisting through the topic tier"
                )

        if len(themes) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
            generated_arcs, title, summary = await consolidate_themes_to_arcs(
                themes,
                providers=providers,
            )
            if generated_arcs:
                arcs = canonicalize_batch_node_ids(
                    generated_arcs,
                    existing_nodes=[*base_nodes, *topics, *themes],
                )
            else:
                title = ""
                summary = ""
                logger.warning(
                    "[HIERARCHY REPAIR] arc consolidation returned no nodes; "
                    "persisting through the theme tier"
                )
    except Exception as exc:  # noqa: BLE001 - repaired base hierarchy remains valid
        logger.exception(
            "[HIERARCHY REPAIR] optional upper-tier rebuild failed; "
            "persisting through level=%d: %s",
            max(node_level(node) for node in [*base_nodes, *topics, *themes]),
            exc,
        )

    repaired_nodes = [*base_nodes, *topics, *themes, *arcs]
    highest_level = max(node_level(node) for node in repaired_nodes)
    hierarchy_stats = synchronize_hierarchy_best_effort(
        repaired_nodes,
        through_parent_level=highest_level,
        required_parent_level=2,
        materialize_membership_edges=materialize_membership_edges,
    )
    if hierarchy_stats["highest_level"] < highest_level:
        logger.warning(
            "[HIERARCHY REPAIR] dropped %d incomplete optional tier(s); "
            "persisting through level=%d",
            hierarchy_stats["optional_tiers_dropped"],
            hierarchy_stats["highest_level"],
        )
    highest_level = hierarchy_stats["highest_level"]
    if highest_level < 5:
        title = ""
        summary = ""
    _assert_unique_ids(repaired_nodes)
    covered_turns = _assert_turn_coverage(repaired_nodes, utterances)
    audit_stats = audit_hierarchy(
        repaired_nodes, through_parent_level=highest_level
    )

    if title:
        metadata["conversation_title"] = title
    if summary:
        metadata["executive_summary"] = summary

    node_count = await persist_graph(
        db=db,
        conversation_id=conversation_id,
        existing_json=repaired_nodes,
        utterances=None,
        conversation_name=conversation.conversation_name,
        source_type=conversation.source_type,
        owner_id=conversation.owner_id,
        source_metadata=metadata,
        indrasnet_group_id=conversation.indrasnet_group_id,
    )
    auditable_nodes = sum(
        1 for node in repaired_nodes if node.get("utterance_ids")
    )
    result = {
        "success": True,
        "conversation_id": conversation_id,
        "utterance_count": len(utterances),
        "covered_turn_count": covered_turns,
        "node_count": node_count,
        "auditable_node_count": auditable_nodes,
        "indrasnet_group_id": conversation.indrasnet_group_id,
        "tier_counts": {
            str(level): sum(1 for node in repaired_nodes if node_level(node) == level)
            for level in range(1, 6)
        },
        "repair": repair_stats,
        "hierarchy": hierarchy_stats,
        "audit": audit_stats,
        "edges": edge_stats,
        "conversation_title": title or metadata.get("conversation_title"),
        "executive_summary": summary or metadata.get("executive_summary"),
    }
    logger.info("[HIERARCHY REPAIR] persisted %s", result)
    return result
