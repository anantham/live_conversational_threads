"""Canonical directed-edge serialization for API and ``.threads`` payloads.

Database ``Relationship`` rows already carry explicit endpoints. This module is
the only boundary that turns those rows into the versioned public edge shape;
callers must not infer direction from node-local compatibility fields.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Optional

from lct_python_backend.services.conversation_reader import TEMPORAL_RELATIONSHIP_TYPES


EDGE_SCHEMA_VERSION = 1
THREADS_FORMAT_VERSION = 2

_RELATION_ALIASES = {
    "support": "supports",
    "rebut": "rebuts",
    "agree": "agrees",
    "disagree": "disagrees",
    "contradict": "contradicts",
    "clarify": "clarifies",
    "generalize": "generalizes",
    "exemplify": "exemplifies",
    "answer": "answers",
    "reference_back": "references_back",
}


def canonical_relation_type(value: Any) -> str:
    """Return the stable public spelling for a directed relation type.

    These aliases change grammar only; none reverse endpoints or infer a
    semantic relation that the author did not provide.
    """
    normalized = str(value or "").strip().lower()
    return _RELATION_ALIASES.get(normalized, normalized)


def edge_schema_descriptor() -> dict[str, Any]:
    """Return a fresh JSON-safe descriptor for the explicit endpoint space."""
    return {
        "version": EDGE_SCHEMA_VERSION,
        "directed": True,
        "endpoint_space": "graph_data.id",
    }


def relationship_edge_kind(relationship_type: Any) -> str:
    """Classify stored relations without fuzzy semantic inference."""
    normalized = canonical_relation_type(relationship_type)
    return "temporal" if normalized in TEMPORAL_RELATIONSHIP_TYPES else "semantic"


def validate_serialized_edge_contract(
    edge_schema: Any,
    edges: Any,
    nodes: Iterable[Any],
) -> list[dict[str, Any]]:
    """Validate a saved explicit contract before making it authoritative."""
    if edge_schema != edge_schema_descriptor():
        raise ValueError("missing or unsupported edge_schema")
    if not isinstance(edges, list):
        raise ValueError("edges must be a list")

    node_ids = {
        str(node.get("id", "") or "").strip()
        for node in (nodes or [])
        if isinstance(node, dict) and str(node.get("id", "") or "").strip()
    }
    edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise ValueError(f"edge {index} must be an object")
        edge_id = str(edge.get("id", "") or "").strip()
        from_id = str(edge.get("from_node_id", "") or "").strip()
        to_id = str(edge.get("to_node_id", "") or "").strip()
        relation_type = str(edge.get("relation_type", "") or "").strip()
        if not edge_id or not from_id or not to_id or not relation_type:
            raise ValueError(f"edge {index} is missing id, endpoints, or relation_type")
        if edge_id in edge_ids:
            raise ValueError(f"duplicate edge id: {edge_id}")
        if from_id == to_id:
            raise ValueError(f"edge {edge_id} cannot reference itself")
        if from_id not in node_ids or to_id not in node_ids:
            raise ValueError(f"edge {edge_id} references an unknown node")
        edge_kind = edge.get("edge_kind")
        if edge_kind is not None and edge_kind not in {"semantic", "temporal"}:
            raise ValueError(f"edge {edge_id} has unsupported edge_kind")
        edge_ids.add(edge_id)
    return edges


def serialize_relationships(
    relationships: Iterable[Any],
    *,
    node_id_transform: Optional[Callable[[str], str]] = None,
    edge_id_transform: Optional[Callable[[str], str]] = None,
) -> list[dict[str, Any]]:
    """Serialize relationship rows without folding direction into nodes.

    ``node_id_transform`` and ``edge_id_transform`` are used by combined
    artifacts to apply the same conversation namespace to nodes and edges.
    """
    transform_node = node_id_transform or (lambda value: value)
    transform_edge = edge_id_transform or (lambda value: value)
    result: list[dict[str, Any]] = []
    result_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}

    for index, relationship in enumerate(relationships or []):
        from_id = str(getattr(relationship, "from_node_id", "") or "").strip()
        to_id = str(getattr(relationship, "to_node_id", "") or "").strip()
        relation_type = canonical_relation_type(
            getattr(relationship, "relationship_type", "")
        )
        if not from_id or not to_id or not relation_type:
            continue

        raw_edge_id = str(getattr(relationship, "id", "") or "").strip()
        if not raw_edge_id:
            raw_edge_id = f"edge-{index}-{from_id}-{to_id}-{relation_type}"

        serialized = {
            "id": transform_edge(raw_edge_id),
            "from_node_id": transform_node(from_id),
            "to_node_id": transform_node(to_id),
            "relation_type": relation_type,
            "edge_kind": relationship_edge_kind(relation_type),
            "relation_subtype": getattr(relationship, "relationship_subtype", None),
            "explanation": getattr(relationship, "explanation", None),
            "strength": getattr(relationship, "strength", None),
            "confidence": getattr(relationship, "confidence", None),
            "is_bidirectional": bool(
                getattr(relationship, "is_bidirectional", False)
            ),
            "supporting_utterance_ids": [
                str(utterance_id)
                for utterance_id in (
                    getattr(relationship, "supporting_utterance_ids", None) or []
                )
            ],
        }
        subtype_key = serialized["relation_subtype"] if relation_type == "member_of" else None
        duplicate_key = (
            serialized["from_node_id"],
            serialized["to_node_id"],
            relation_type,
            subtype_key,
        )
        existing = result_by_key.get(duplicate_key)
        if existing is not None:
            known_ids = set(existing["supporting_utterance_ids"])
            for utterance_id in serialized["supporting_utterance_ids"]:
                if utterance_id not in known_ids:
                    known_ids.add(utterance_id)
                    existing["supporting_utterance_ids"].append(utterance_id)
            if not existing.get("explanation") and serialized.get("explanation"):
                existing["explanation"] = serialized["explanation"]
            continue
        result.append(serialized)
        result_by_key[duplicate_key] = serialized

    return result
