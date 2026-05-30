"""Thematic structure read/serialization.

The generation half (analyze_conversation / _call_llm_for_analysis /
_build_thematic_analysis_prompt / _save_thematic_structure) was superseded by the
hierarchical-themes clusterers (services/hierarchical_themes) and removed
2026-05-30 — it had no caller and used a raw httpx→OpenRouter path that bypassed the
LLM gateway (surface-tech-debt review). The only live use is reading an already-
generated level-2 structure for the GET /themes/levels endpoint, so that is all this
class now does.
"""

import logging
import uuid
from typing import Any, Dict, List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Node, Relationship

logger = logging.getLogger(__name__)


class ThematicAnalyzer:
    """Serializes an existing thematic (level-2) structure from the database."""

    def __init__(self, db_session: AsyncSession):
        self.db = db_session

    async def _serialize_existing_structure(
        self,
        nodes: List[Node],
        conversation_id: str,
    ) -> Dict[str, Any]:
        """Serialize existing thematic structure (nodes + relationships) from the DB."""
        thematic_nodes = []
        node_id_to_label = {}

        for node in nodes:
            thematic_nodes.append({
                "id": str(node.id),
                "label": node.node_name,
                "summary": node.summary,
                "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
                "node_type": node.node_type,
                "timestamp_start": node.timestamp_start,
                "timestamp_end": node.timestamp_end
            })
            node_id_to_label[node.id] = node.node_name

        # Fetch relationships
        edges_result = await self.db.execute(
            select(Relationship).where(
                Relationship.conversation_id == uuid.UUID(conversation_id)
            )
        )
        relationships = edges_result.scalars().all()

        edges = []
        for rel in relationships:
            if rel.from_node_id in node_id_to_label and rel.to_node_id in node_id_to_label:
                edges.append({
                    "source": str(rel.from_node_id),  # Use node ID, not label
                    "target": str(rel.to_node_id),    # Use node ID, not label
                    "type": rel.relationship_type,
                    "description": rel.explanation
                })

        # Debug logging for edge data flow
        logger.debug(f"Returning {len(edges)} edges from _serialize_existing_structure:")
        for edge in edges:
            logger.debug(f"  Edge: {edge['source']} -> {edge['target']} (type: {edge['type']})")
        logger.debug(f"Node IDs available: {list(node_id_to_label.keys())}")

        return {
            "thematic_nodes": thematic_nodes,
            "edges": edges,
            "summary": {
                "total_themes": len(thematic_nodes),
                "total_edges": len(edges),
                "from_cache": True
            }
        }
