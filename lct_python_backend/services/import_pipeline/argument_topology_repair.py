"""Edge-only repair for an already-persisted conversation graph.

This service deliberately does not call transcript extraction, hierarchy
repair, consolidation, synchronization, or ``persist_graph``.  It scans the
existing nodes, validates every bounded edge window, and then atomically
replaces only relationships previously authored by the argument-topology pass.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from sqlalchemy import delete

from lct_python_backend.models import Relationship
from lct_python_backend.services.conversation_reader import (
    build_graph_data_from_nodes,
    fetch_conversation_bundle,
)
from lct_python_backend.services.deployment_privacy_policy import (
    constrain_llm_config_for_privacy,
    select_providers_for_privacy,
)
from lct_python_backend.services.edge_enrichment import run_edge_enrichment
from lct_python_backend.services.import_pipeline.import_orchestrator import (
    _is_local_provider,
    _safe_text,
    _topology_marker,
)
from lct_python_backend.services.import_pipeline.persisted_hierarchy_repair import (
    _resolve_conversation,
)
from lct_python_backend.services.llm_config import load_llm_config, load_llm_providers

logger = logging.getLogger("lct_backend")

ARGUMENT_TOPOLOGY_SUBTYPE = "argument_topology:v1"
ARGUMENT_EDGE_NAMESPACE = uuid.UUID("d7e210f8-0d76-4a87-a34e-388e346de879")
PRESERVED_RELATION_TYPES = {
    "member_of", "temporal", "leads_to", "next", "follows", "contextual",
}


def relationship_is_replaceable_argument_edge(
    relationship: Any, *, previous_marker: Optional[Dict[str, Any]] = None
) -> bool:
    """Identify edges owned by this pass without touching structural edges."""
    relation_type = _safe_text(
        getattr(relationship, "relationship_type", "")
    ).lower()
    subtype = _safe_text(
        getattr(relationship, "relationship_subtype", "")
    ).lower()
    if relation_type in PRESERVED_RELATION_TYPES:
        return False
    if subtype == ARGUMENT_TOPOLOGY_SUBTYPE:
        return True

    # Compatibility for PR-170-era scans, which stored subtype=relation_type
    # before the dedicated provenance tag existed. Restrict deletion to types
    # recorded by the prior completion marker.
    prior_counts = (
        previous_marker.get("relation_type_counts")
        if isinstance(previous_marker, dict)
        else {}
    )
    prior_types = {
        _safe_text(value).lower()
        for value in (prior_counts or {}).keys()
        if _safe_text(value)
    }
    return relation_type in prior_types and subtype in {"", relation_type}


def _edge_uuid(conversation_id: uuid.UUID, edge: Dict[str, Any]) -> uuid.UUID:
    return uuid.uuid5(
        ARGUMENT_EDGE_NAMESPACE,
        ":".join([
            str(conversation_id),
            _safe_text(edge.get("from_node_id")),
            _safe_text(edge.get("to_node_id")),
            _safe_text(edge.get("relation_type")).lower(),
        ]),
    )


def _uuid_list(values: Any) -> list[uuid.UUID]:
    result: list[uuid.UUID] = []
    for value in values if isinstance(values, list) else []:
        try:
            identifier = uuid.UUID(str(value))
        except (TypeError, ValueError, AttributeError):
            continue
        if identifier not in result:
            result.append(identifier)
    return result


def _scan_failure_reason(telemetry: Dict[str, Any]) -> Optional[str]:
    llm = telemetry.get("llm_telemetry") or {}
    error = _safe_text(llm.get("error"))
    parse_status = _safe_text(llm.get("parse_status")).lower()
    if error:
        return error
    if parse_status != "valid":
        return "invalid_edge_payload"
    return None


async def repair_persisted_argument_topology(
    db,
    *,
    conversation_id: Optional[str] = None,
    group_id: Optional[str] = None,
    owner_id: str = "anonymous",
) -> Dict[str, Any]:
    """Re-run only bounded edge extraction and atomically replace its rows."""
    conversation = await _resolve_conversation(
        db,
        conversation_id=conversation_id,
        group_id=group_id,
        owner_id=owner_id,
    )
    conversation, db_nodes, relationships, utterances = await fetch_conversation_bundle(
        db, conversation.id
    )
    if not db_nodes:
        raise ValueError("conversation has no persisted graph nodes to scan")

    graph_nodes = build_graph_data_from_nodes(
        db_nodes,
        relationships,
        utterances=utterances,
        include_edges_out=False,
    )
    metadata = dict(conversation.source_metadata or {})
    privacy = metadata.get("privacy") if isinstance(metadata.get("privacy"), dict) else None
    providers_config = await load_llm_providers(db, include_secrets=True)
    providers = (
        providers_config.get("providers")
        if isinstance(providers_config, dict)
        else []
    ) or []
    providers = select_providers_for_privacy(providers, privacy)
    local_providers = [provider for provider in providers if _is_local_provider(provider)]
    llm_config = constrain_llm_config_for_privacy(await load_llm_config(db), privacy)

    if not local_providers:
        enrichment_telemetry = {
            "llm_telemetry": {
                "parse_status": "invalid",
                "error": "no_privacy_eligible_local_provider",
                "window_count": 0,
                "completed_windows": 0,
            }
        }
        semantic_edges = []
    else:
        semantic_edges, enrichment_telemetry = await run_edge_enrichment(
            nodes=graph_nodes,
            query_summary="",
            llm_config=llm_config,
            providers=local_providers,
            skip_context_lookup=True,
        )

    failure_reason = _scan_failure_reason(enrichment_telemetry)
    previous_marker = metadata.get("argument_topology")
    if failure_reason:
        retained_previous = bool(
            isinstance(previous_marker, dict)
            and previous_marker.get("status") == "complete"
        )
        if not retained_previous:
            previous_marker = _topology_marker(
                [], status="failed", reason=failure_reason
            )
            metadata["argument_topology"] = previous_marker
            conversation.source_metadata = metadata
            await db.commit()
        logger.error(
            "[TOPOLOGY REPAIR] conversation=%s failed reason=%s retained_previous=%s",
            conversation.id, failure_reason, retained_previous,
        )
        return {
            "success": False,
            "conversation_id": str(conversation.id),
            "argument_topology": previous_marker,
            "retained_previous_complete_scan": retained_previous,
            "scan": enrichment_telemetry.get("llm_telemetry") or {},
        }

    replace_ids = [
        relationship.id
        for relationship in relationships
        if relationship_is_replaceable_argument_edge(
            relationship, previous_marker=previous_marker
        )
    ]
    if replace_ids:
        await db.execute(
            delete(Relationship).where(Relationship.id.in_(replace_ids))
        )

    node_ids = {str(node.id) for node in db_nodes}
    for edge in semantic_edges:
        source_id = _safe_text(edge.get("from_node_id"))
        target_id = _safe_text(edge.get("to_node_id"))
        relation_type = _safe_text(edge.get("relation_type")).lower()
        if (
            source_id not in node_ids or target_id not in node_ids
            or source_id == target_id or not relation_type
        ):
            raise ValueError("validated topology edge references an invalid node")
        try:
            confidence = float(edge.get("confidence"))
        except (TypeError, ValueError):
            confidence = 0.9
        db.add(Relationship(
            id=_edge_uuid(conversation.id, edge),
            conversation_id=conversation.id,
            from_node_id=uuid.UUID(source_id),
            to_node_id=uuid.UUID(target_id),
            relationship_type=relation_type,
            relationship_subtype=ARGUMENT_TOPOLOGY_SUBTYPE,
            explanation=_safe_text(edge.get("explanation")) or relation_type,
            strength=0.8,
            confidence=max(0.0, min(1.0, confidence)),
            is_bidirectional=False,
            supporting_utterance_ids=_uuid_list(
                edge.get("supporting_utterance_ids")
            ),
        ))

    marker = _topology_marker(semantic_edges, status="complete")
    metadata["argument_topology"] = marker
    conversation.source_metadata = metadata
    await db.commit()
    result = {
        "success": True,
        "conversation_id": str(conversation.id),
        "argument_topology": marker,
        "replaced_argument_edge_count": len(replace_ids),
        "scan": enrichment_telemetry.get("llm_telemetry") or {},
    }
    logger.info("[TOPOLOGY REPAIR] persisted %s", result)
    return result
