"""Obsidian Canvas export/import API endpoints."""
import io
import json
import logging
import math
import re
import uuid
import zipfile
from collections import deque
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation
from lct_python_backend.schemas import SaveJsonResponse
from lct_python_backend.services.conversation_artifacts import (
    build_linear_transcript_text,
    sanitize_artifact_basename,
)
from lct_python_backend.services.conversation_reader import (
    build_chunk_dict_from_utterances,
    build_graph_data_from_nodes,
    fetch_conversation_bundle,
)
from lct_python_backend.services.gcs_helpers import save_json_to_gcs
from lct_python_backend.services.owner_context import resolve_owner_id

logger = logging.getLogger(__name__)
router = APIRouter(tags=["canvas"])


# ============================================================================
# Pydantic Models
# ============================================================================

class CanvasNode(BaseModel):
    id: str
    type: str  # "text", "file", "link", "group"
    x: int
    y: int
    width: int
    height: int
    color: Optional[str] = None
    text: Optional[str] = None  # For text nodes
    file: Optional[str] = None  # For file nodes
    url: Optional[str] = None  # For link nodes
    label: Optional[str] = None  # For group nodes

class CanvasEdge(BaseModel):
    id: str
    fromNode: str
    toNode: str
    fromSide: Optional[str] = None
    toSide: Optional[str] = None
    fromEnd: Optional[str] = "none"
    toEnd: Optional[str] = "arrow"
    color: Optional[str] = None
    label: Optional[str] = None

class ObsidianCanvas(BaseModel):
    nodes: List[CanvasNode]
    edges: List[CanvasEdge]

class CanvasExportRequest(BaseModel):
    conversation_id: str
    file_name: Optional[str] = None
    include_chunks: bool = False  # Whether to include chunk content as separate nodes

class CanvasImportRequest(BaseModel):
    canvas_data: ObsidianCanvas
    file_name: str
    preserve_positions: bool = True


# ============================================================================
# Converter Functions
# ============================================================================

def _clean_str(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _extract_contextual_relation_entries(value: object) -> List[tuple[str, str]]:
    if not value:
        return []

    entries: List[tuple[str, str]] = []

    if isinstance(value, dict):
        related_node = _clean_str(
            value.get("related_node_name")
            or value.get("related_node")
            or value.get("relatedNode")
            or value.get("source")
            or value.get("from")
            or value.get("node")
        )
        relation_text = _clean_str(
            value.get("relation_text")
            or value.get("relationText")
            or value.get("description")
            or value.get("explanation")
        )
        single_relation_keys = {
            "related_node_name",
            "related_node",
            "relatedNode",
            "source",
            "from",
            "node",
            "relation_text",
            "relationText",
            "description",
            "explanation",
            "relation_type",
            "type",
        }
        if (
            related_node
            and relation_text
            and set(str(key).strip() for key in value.keys()).issubset(single_relation_keys)
        ):
            entries.append((related_node, relation_text))
            return entries

        for key, raw_text in value.items():
            node_name = _clean_str(key)
            text = _clean_str(raw_text)
            if node_name and text:
                entries.append((node_name, text))
        return entries

    if isinstance(value, list):
        for item in value:
            entries.extend(_extract_contextual_relation_entries(item))

    return entries


def convert_conversation_to_canvas(
    graph_data: List,
    chunk_dict: Dict[str, str],
    file_name: str,
    include_chunks: bool = False,
    edge_records: Optional[List[Dict[str, str]]] = None,
) -> ObsidianCanvas:
    """
    Convert conversation tree format to Obsidian Canvas format.

    Args:
        graph_data: List containing conversation nodes (format: [[nodes]])
        chunk_dict: Dictionary mapping chunk IDs to text content
        file_name: Name of the conversation (used for title node)
        include_chunks: Whether to include chunk content as separate nodes
        edge_records: Optional list of precomputed edges to inject (from relationships)

    Returns:
        ObsidianCanvas object with nodes and edges
    """
    nodes: List[CanvasNode] = []
    edges: List[CanvasEdge] = []

    # Extract nodes from graph_data (format is usually [[nodes]])
    if graph_data and isinstance(graph_data[0], list):
        conversation_nodes = graph_data[0]
    elif isinstance(graph_data, list):
        conversation_nodes = graph_data
    else:
        conversation_nodes = []

    if not conversation_nodes:
        raise ValueError("No nodes found in conversation data")

    NODE_WIDTH = 350
    NODE_HEIGHT = 200
    HORIZONTAL_SPACING = 520
    VERTICAL_SPACING = 280
    COMPONENT_GAP = 420
    MAX_ROW_WIDTH = 4600

    canonical_nodes: List[Dict[str, object]] = []
    used_canvas_ids: set[str] = set()
    node_id_to_canvas_id: Dict[str, str] = {}
    node_name_to_canvas_id: Dict[str, str] = {}
    legacy_node_name_to_canvas_id: Dict[str, str] = {}

    for index, raw_node in enumerate(conversation_nodes):
        if not isinstance(raw_node, dict):
            continue
        node_name = _clean_str(raw_node.get("node_name") or raw_node.get("title") or raw_node.get("name"))
        if not node_name:
            node_name = f"Node {index + 1}"

        raw_id = _clean_str(raw_node.get("id") or raw_node.get("node_id"))
        canvas_id = raw_id or node_name.replace(" ", "_") or f"node_{index + 1}"
        if canvas_id in used_canvas_ids:
            canvas_id = f"{canvas_id}_{index + 1}"
        used_canvas_ids.add(canvas_id)

        canonical_nodes.append(
            {
                "canvas_id": canvas_id,
                "node_name": node_name,
                "raw": raw_node,
            }
        )

        if raw_id:
            node_id_to_canvas_id[raw_id] = canvas_id
        node_name_to_canvas_id.setdefault(node_name, canvas_id)
        legacy_node_name_to_canvas_id.setdefault(node_name.replace(" ", "_"), canvas_id)

    if not canonical_nodes:
        raise ValueError("No valid nodes found in conversation data")

    node_lookup = {item["canvas_id"]: item for item in canonical_nodes}
    node_order_index = {item["canvas_id"]: index for index, item in enumerate(canonical_nodes)}

    def resolve_node_ref(ref: object) -> Optional[str]:
        token = _clean_str(ref)
        if not token:
            return None
        if token in node_lookup:
            return token
        if token in node_id_to_canvas_id:
            return node_id_to_canvas_id[token]
        if token in node_name_to_canvas_id:
            return node_name_to_canvas_id[token]
        if token in legacy_node_name_to_canvas_id:
            return legacy_node_name_to_canvas_id[token]
        return None

    temporal_edges: List[tuple[str, str]] = []
    contextual_edges: List[tuple[str, str, str, str]] = []
    supplied_edges: List[tuple[str, str, str, str]] = []
    temporal_seen = set()
    contextual_seen = set()

    for item in canonical_nodes:
        raw_node = item["raw"]
        source_id = item["canvas_id"]

        successor_id = resolve_node_ref(raw_node.get("successor"))
        if successor_id and successor_id != source_id:
            key = (source_id, successor_id)
            if key not in temporal_seen:
                temporal_seen.add(key)
                temporal_edges.append(key)

        predecessor_id = resolve_node_ref(raw_node.get("predecessor"))
        if predecessor_id and predecessor_id != source_id:
            key = (predecessor_id, source_id)
            if key not in temporal_seen:
                temporal_seen.add(key)
                temporal_edges.append(key)

        raw_relations = raw_node.get("edge_relations")
        if isinstance(raw_relations, list):
            for relation in raw_relations:
                if not isinstance(relation, dict):
                    continue
                related_name = _clean_str(
                    relation.get("related_node")
                    or relation.get("related_node_name")
                    or relation.get("relatedNode")
                    or relation.get("source")
                    or relation.get("from")
                    or relation.get("node")
                )
                related_id = resolve_node_ref(related_name)
                if not related_id or related_id == source_id:
                    continue
                relation_type = _clean_str(relation.get("relation_type") or relation.get("type")).lower() or "contextual"
                relation_text = _clean_str(
                    relation.get("relation_text")
                    or relation.get("relationText")
                    or relation.get("description")
                    or relation.get("explanation")
                )
                if not relation_text:
                    relation_text = f"{related_name} -> {item['node_name']}"
                label = relation_text[:50] + "..." if len(relation_text) > 50 else relation_text
                if relation_type in {"supports", "informs", "builds_on", "enables", "affirms"}:
                    color = "4"
                elif relation_type in {"contradicts", "opposes", "refutes", "challenges", "conflicts", "disagrees", "rebuts"}:
                    color = "1"
                else:
                    color = "3"
                edge_key = (related_id, source_id, label, color)
                if edge_key not in contextual_seen:
                    contextual_seen.add(edge_key)
                    contextual_edges.append(edge_key)

        for related_name, explanation in _extract_contextual_relation_entries(raw_node.get("contextual_relation")):
            related_id = resolve_node_ref(related_name)
            if not related_id or related_id == source_id:
                continue
            relation_text = _clean_str(explanation) or "related"
            label = relation_text[:50] + "..." if len(relation_text) > 50 else relation_text
            edge_key = (related_id, source_id, label, "3")
            if edge_key not in contextual_seen:
                contextual_seen.add(edge_key)
                contextual_edges.append(edge_key)

    if edge_records:
        for rec in edge_records:
            source = resolve_node_ref(rec.get("fromNode") or rec.get("from") or rec.get("source"))
            target = resolve_node_ref(rec.get("toNode") or rec.get("to") or rec.get("target"))
            if not source or not target or source == target:
                continue
            label = _clean_str(rec.get("label") or rec.get("type")) or "related"
            color = _clean_str(rec.get("color")) or "3"
            supplied_edges.append((source, target, label, color))
            rel_type = label.lower()
            if rel_type in {"next", "leads_to", "follows"}:
                key = (source, target)
                if key not in temporal_seen:
                    temporal_seen.add(key)
                    temporal_edges.append(key)

    # Build connected components using all known edges so related subgraphs are co-located.
    layout_pairs = {(source, target) for source, target in temporal_edges}
    contextual_layout_pairs = {(source, target) for source, target, _, _ in contextual_edges}
    contextual_layout_pairs.update(
        (source, target)
        for source, target, label, _ in supplied_edges
        if _clean_str(label).lower() not in {"next", "leads_to", "follows", "temporal"}
    )
    layout_pairs.update(contextual_layout_pairs)
    layout_pairs.update((source, target) for source, target, _, _ in supplied_edges)
    adjacency = {item["canvas_id"]: set() for item in canonical_nodes}
    contextual_adjacency = {item["canvas_id"]: set() for item in canonical_nodes}
    for source, target in layout_pairs:
        if source in adjacency and target in adjacency:
            adjacency[source].add(target)
            adjacency[target].add(source)
    for source, target in contextual_layout_pairs:
        if source in contextual_adjacency and target in contextual_adjacency:
            contextual_adjacency[source].add(target)
            contextual_adjacency[target].add(source)

    components: List[List[str]] = []
    visited: set[str] = set()
    for item in canonical_nodes:
        start_id = item["canvas_id"]
        if start_id in visited:
            continue
        stack = [start_id]
        component: List[str] = []
        visited.add(start_id)
        while stack:
            current = stack.pop()
            component.append(current)
            for neighbor in adjacency.get(current, set()):
                if neighbor in visited:
                    continue
                visited.add(neighbor)
                stack.append(neighbor)
        component.sort(key=lambda node_id: node_order_index.get(node_id, 0))
        components.append(component)

    temporal_out = {item["canvas_id"]: set() for item in canonical_nodes}
    for source, target in temporal_edges:
        if source in temporal_out:
            temporal_out[source].add(target)

    node_positions: Dict[str, Dict[str, int]] = {}
    cursor_x = 100
    cursor_y = 100
    current_row_height = 0

    for component in components:
        component_set = set(component)
        component_contextual_edges = sum(
            1
            for node_id in component
            for neighbor_id in contextual_adjacency.get(node_id, set())
            if neighbor_id in component_set and node_id < neighbor_id
        )
        component_temporal_edges = sum(
            1
            for source in component
            for target in temporal_out.get(source, set())
            if target in component_set
        )
        root_candidate = max(
            component,
            key=lambda node_id: (
                len(contextual_adjacency.get(node_id, set()) & component_set),
                len(adjacency.get(node_id, set()) & component_set),
                -node_order_index.get(node_id, 0),
            ),
        )
        use_contextual_layout = (
            len(component) >= 4
            and component_contextual_edges >= max(3, component_temporal_edges)
            and len(contextual_adjacency.get(root_candidate, set()) & component_set) >= 2
        )

        local_positions: Dict[str, Dict[str, int]] = {}
        if use_contextual_layout:
            ring_distance = {root_candidate: 0}
            queue = deque([root_candidate])
            while queue:
                current_id = queue.popleft()
                current_distance = ring_distance[current_id]
                neighbors = sorted(
                    contextual_adjacency.get(current_id, set()) & component_set,
                    key=lambda node_id: (
                        -len(contextual_adjacency.get(node_id, set()) & component_set),
                        node_order_index.get(node_id, 0),
                    ),
                )
                for neighbor_id in neighbors:
                    if neighbor_id in ring_distance:
                        continue
                    ring_distance[neighbor_id] = current_distance + 1
                    queue.append(neighbor_id)

            fallback_queue = deque([root_candidate])
            seen = {root_candidate}
            while fallback_queue:
                current_id = fallback_queue.popleft()
                current_distance = ring_distance.get(current_id, 0)
                for neighbor_id in sorted(
                    adjacency.get(current_id, set()) & component_set,
                    key=lambda node_id: node_order_index.get(node_id, 0),
                ):
                    if neighbor_id in seen:
                        continue
                    seen.add(neighbor_id)
                    ring_distance.setdefault(neighbor_id, current_distance + 1)
                    fallback_queue.append(neighbor_id)

            rings: Dict[int, List[str]] = {}
            for node_id in component:
                rings.setdefault(ring_distance.get(node_id, 0), []).append(node_id)
            for node_ids in rings.values():
                node_ids.sort(
                    key=lambda node_id: (
                        -len(contextual_adjacency.get(node_id, set()) & component_set),
                        node_order_index.get(node_id, 0),
                    )
                )

            local_positions[root_candidate] = {"x": 0, "y": 0}
            for ring_index, node_ids in sorted(rings.items()):
                if ring_index == 0:
                    continue
                count = len(node_ids)
                radius_x = max(HORIZONTAL_SPACING, int(ring_index * HORIZONTAL_SPACING * 1.1))
                radius_y = max(VERTICAL_SPACING, int(ring_index * VERTICAL_SPACING * 1.15))
                for item_index, node_id in enumerate(node_ids):
                    angle = (2 * math.pi * item_index) / max(1, count)
                    local_positions[node_id] = {
                        "x": int(round(math.cos(angle) * radius_x)),
                        "y": int(round(math.sin(angle) * radius_y)),
                    }
        else:
            depth = {node_id: 0 for node_id in component}

            for _ in range(len(component)):
                changed = False
                for source in component:
                    for target in temporal_out.get(source, set()):
                        if target not in component_set:
                            continue
                        candidate = depth[source] + 1
                        if candidate > depth[target]:
                            depth[target] = candidate
                            changed = True
                if not changed:
                    break

            if len(set(depth.values())) == 1 and len(component) > 1:
                for index, node_id in enumerate(component):
                    depth[node_id] = index

            levels: Dict[int, List[str]] = {}
            for node_id in component:
                levels.setdefault(depth[node_id], []).append(node_id)
            for node_ids in levels.values():
                node_ids.sort(key=lambda node_id: node_order_index.get(node_id, 0))

            for level in sorted(levels.keys()):
                for row_index, node_id in enumerate(levels[level]):
                    local_positions[node_id] = {
                        "x": level * HORIZONTAL_SPACING,
                        "y": row_index * VERTICAL_SPACING,
                    }

        min_x = min((position["x"] for position in local_positions.values()), default=0)
        max_x = max((position["x"] for position in local_positions.values()), default=0)
        min_y = min((position["y"] for position in local_positions.values()), default=0)
        max_y = max((position["y"] for position in local_positions.values()), default=0)
        component_width = (max_x - min_x) + NODE_WIDTH
        component_height = (max_y - min_y) + NODE_HEIGHT

        if cursor_x + component_width > MAX_ROW_WIDTH:
            cursor_x = 100
            cursor_y += current_row_height + COMPONENT_GAP
            current_row_height = 0

        for node_id, local_position in local_positions.items():
            node_positions[node_id] = {
                "x": cursor_x + (local_position["x"] - min_x),
                "y": cursor_y + (local_position["y"] - min_y),
            }

        cursor_x += component_width + COMPONENT_GAP
        current_row_height = max(current_row_height, component_height)

    valid_node_ids = set(node_lookup.keys())
    edge_counter = 0
    created_edges = set()

    def add_edge(
        from_id: str,
        to_id: str,
        label: str,
        color: str,
        from_side=None,
        to_side=None,
        from_end="none",
        to_end="arrow",
    ):
        nonlocal edge_counter
        if from_id not in valid_node_ids or to_id not in valid_node_ids or from_id == to_id:
            return
        edge_key = f"{from_id}->{to_id}:{label}:{color}"
        if edge_key in created_edges:
            return
        edges.append(
            CanvasEdge(
                id=f"edge_{edge_counter}",
                fromNode=from_id,
                toNode=to_id,
                fromSide=from_side,
                toSide=to_side,
                fromEnd=from_end,
                toEnd=to_end,
                color=color,
                label=label,
            )
        )
        created_edges.add(edge_key)
        edge_counter += 1

    # Create Canvas nodes
    for item in canonical_nodes:
        node_id = item["canvas_id"]
        raw_node = item["raw"]
        node_name = item["node_name"]
        position = node_positions.get(node_id, {"x": 100, "y": 100})

        color = None
        if raw_node.get("is_bookmark"):
            color = "5"
        elif raw_node.get("is_contextual_progress"):
            color = "4"

        text_content = f"# {node_name}\n\n"
        text_content += f"{_clean_str(raw_node.get('summary'))}\n\n"

        claims = raw_node.get("claims")
        if isinstance(claims, list) and claims:
            text_content += "## Claims\n"
            for claim in claims:
                text_content += f"- {_clean_str(claim)}\n"
            text_content += "\n"

        chunk_id = _clean_str(raw_node.get("chunk_id"))
        if chunk_id and not include_chunks:
            text_content += f"*Chunk ID: {chunk_id}*\n"

        estimated_height = max(NODE_HEIGHT, min(600, len(text_content) // 3))
        nodes.append(
            CanvasNode(
                id=node_id,
                type="text",
                x=position["x"],
                y=position["y"],
                width=NODE_WIDTH,
                height=estimated_height,
                color=color,
                text=text_content,
            )
        )

    # Preferred relationship edges from DB/export payload.
    for source, target, label, color in supplied_edges:
        add_edge(source, target, label, color, from_end="none", to_end="arrow")

    # Temporal edges from transcript output.
    for source, target in temporal_edges:
        add_edge(source, target, "next", "1", from_side="right", to_side="left", to_end="arrow")

    # Contextual edges from transcript output.
    for source, target, label, color in contextual_edges:
        add_edge(source, target, label or "related", color or "3", from_end="none", to_end="none")

    # Add chunk nodes if requested
    if include_chunks:
        chunk_y = max((pos["y"] for pos in node_positions.values()), default=0) + VERTICAL_SPACING * 2
        chunk_x = 100

        for chunk_id, chunk_text in chunk_dict.items():
            chunk_id_text = _clean_str(chunk_id)
            chunk_node_id = f"chunk_{chunk_id_text}"
            nodes.append(
                CanvasNode(
                    id=chunk_node_id,
                    type="text",
                    x=chunk_x,
                    y=chunk_y,
                    width=NODE_WIDTH,
                    height=300,
                    color="6",
                    text=f"# Chunk: {chunk_id_text}\n\n{_clean_str(chunk_text)[:500]}...",
                )
            )

            for item in canonical_nodes:
                node_chunk_id = _clean_str(item["raw"].get("chunk_id"))
                if node_chunk_id != chunk_id_text:
                    continue
                edges.append(
                    CanvasEdge(
                        id=f"edge_{edge_counter}",
                        fromNode=item["canvas_id"],
                        toNode=chunk_node_id,
                        fromEnd="none",
                        toEnd="none",
                        color="2",
                        label="references",
                    )
                )
                edge_counter += 1

            chunk_x += HORIZONTAL_SPACING
            if chunk_x > 2000:
                chunk_x = 100
                chunk_y += VERTICAL_SPACING

    return ObsidianCanvas(nodes=nodes, edges=edges)


def convert_canvas_to_conversation(canvas: ObsidianCanvas, preserve_positions: bool = True) -> tuple:
    """
    Convert Obsidian Canvas format to conversation tree format.

    Args:
        canvas: ObsidianCanvas object with nodes and edges
        preserve_positions: Whether to preserve node positions (stored in metadata)

    Returns:
        Tuple of (graph_data, chunk_dict)
    """
    conversation_nodes = []
    chunk_dict = {}

    # Build maps for edges
    temporal_edges = {}  # node_id -> successor_id (for predecessor/successor)
    contextual_edges = {}  # node_id -> [(target_id, label)]

    for edge in canvas.edges:
        edge_label = _clean_str(edge.label).lower()

        # Temporal edges must be explicitly labelled as temporal.
        if edge_label in {"next", "leads_to", "follows"}:
            temporal_edges[edge.fromNode] = edge.toNode
        # Chunk reference edges
        elif edge.label == "references" or edge.color == "2":
            continue  # Skip chunk reference edges for now
        # Contextual edges
        else:
            if edge.fromNode not in contextual_edges:
                contextual_edges[edge.fromNode] = []
            contextual_edges[edge.fromNode].append((edge.toNode, edge.label or "Related"))

    text_nodes: List[CanvasNode] = []
    node_title_by_id: Dict[str, str] = {}

    for node in canvas.nodes:
        if node.type != "text":
            continue
        if node.id.startswith("chunk_"):
            chunk_id = node.id.replace("chunk_", "")
            chunk_dict[chunk_id] = node.text or ""
            continue

        text_nodes.append(node)
        node_name_from_id = node.id.replace("_", " ")
        text = node.text or ""
        lines = text.split("\n")
        title = node_name_from_id
        if lines and lines[0].startswith("#"):
            parsed_title = lines[0].replace("#", "").strip()
            if parsed_title:
                title = parsed_title
        node_title_by_id[node.id] = title

    # Process non-chunk text nodes
    for node in text_nodes:
        # Parse text content to extract summary and other fields
        text = node.text or ""
        lines = text.split("\n")
        title = node_title_by_id.get(node.id) or node.id.replace("_", " ")

        # Extract summary (everything between title and ## Claims)
        summary_lines = []
        claims = []
        in_claims = False

        for line in lines[1:]:
            if line.strip().startswith("## Claims"):
                in_claims = True
                continue
            if line.strip().startswith("*Chunk ID:"):
                continue

            if in_claims:
                if line.strip().startswith("-"):
                    claims.append(line.strip()[1:].strip())
            else:
                summary_lines.append(line)

        summary = "\n".join(summary_lines).strip()

        # Determine flags from color
        is_bookmark = node.color == "5"
        is_contextual_progress = node.color == "4"

        # Find predecessor (reverse lookup in temporal_edges)
        predecessor = None
        for from_id, to_id in temporal_edges.items():
            if to_id == node.id:
                predecessor = node_title_by_id.get(from_id) or from_id.replace("_", " ")
                break

        # Find successor
        successor = temporal_edges.get(node.id)
        if successor:
            successor = node_title_by_id.get(successor) or successor.replace("_", " ")

        # Build contextual_relation map
        contextual_relation = {}
        linked_nodes = []
        if node.id in contextual_edges:
            for target_id, label in contextual_edges[node.id]:
                target_name = node_title_by_id.get(target_id) or target_id.replace("_", " ")
                contextual_relation[target_name] = label
                linked_nodes.append(target_name)

        # Also check reverse edges
        for from_id, edges_list in contextual_edges.items():
            for target_id, label in edges_list:
                if target_id == node.id:
                    source_name = node_title_by_id.get(from_id) or from_id.replace("_", " ")
                    if source_name not in contextual_relation:
                        contextual_relation[source_name] = label
                        linked_nodes.append(source_name)

        # Create conversation node
        conv_node = {
            "node_name": title,
            "type": "conversational_thread",
            "predecessor": predecessor,
            "successor": successor,
            "chunk_id": None,  # We'll try to preserve this from metadata if possible
            "is_bookmark": is_bookmark,
            "is_contextual_progress": is_contextual_progress,
            "summary": summary,
            "claims": claims if claims else [],
            "contextual_relation": contextual_relation,
            "linked_nodes": list(set(linked_nodes))  # Remove duplicates
        }

        # Optionally preserve position data as metadata (for future use)
        if preserve_positions:
            conv_node["_canvas_metadata"] = {
                "x": node.x,
                "y": node.y,
                "width": node.width,
                "height": node.height
            }

        conversation_nodes.append(conv_node)

    # Wrap in the expected format
    graph_data = [conversation_nodes]

    return graph_data, chunk_dict


# ============================================================================
# Hierarchical Canvas Helpers
# ============================================================================

def _slugify(text: str, max_len: int = 35) -> str:
    slug = re.sub(r"[^\w\s]", "", (text or "").lower())
    slug = re.sub(r"\s+", "_", slug).strip("_")
    return slug[:max_len]


def build_hierarchical_canvas_set(
    nodes: list,
    relationships: list,
    base_filename: str,
    canvas_dir_path: str,
) -> dict:
    """
    Build a set of linked Obsidian canvas files from a hierarchical node tree.

    Returns a dict of {filename: canvas_json_dict}.
    Falls back to a single flat canvas if no L2 hierarchy exists.
    """
    # Group nodes by level (1=top/summary, 5=atomic)
    by_level: dict = {}
    id_to_node: dict = {}
    for node in nodes:
        lvl = getattr(node, "level", None) or 0
        by_level.setdefault(lvl, []).append(node)
        id_to_node[node.id] = node

    l2_nodes = by_level.get(2, [])

    # Fallback: no hierarchy → return single flat canvas using existing exporter
    if not l2_nodes:
        logger.info("[HIERARCHICAL CANVAS] No L2 nodes found — falling back to flat canvas")
        # Build minimal graph_data for convert_conversation_to_canvas
        node_data_list = [
            {
                "id": str(n.id),
                "node_name": n.node_name,
                "summary": n.summary,
                "claims": [],
                "key_points": n.key_points or [],
                "predecessor": None,
                "successor": None,
                "contextual_relation": {},
                "linked_nodes": [],
                "is_bookmark": n.is_bookmark,
                "is_contextual_progress": n.is_contextual_progress,
                "chunk_id": str(n.chunk_ids[0]) if n.chunk_ids else None,
                "utterance_ids": [str(uid) for uid in (n.utterance_ids or [])],
            }
            for n in nodes
        ]
        rel_records = [
            {
                "id": f"edge_{r.id}",
                "fromNode": str(r.from_node_id),
                "toNode": str(r.to_node_id),
                "label": r.relationship_type or "related",
                "color": "3",
            }
            for r in relationships
        ]
        canvas = convert_conversation_to_canvas(
            [node_data_list], {}, base_filename, False, edge_records=rel_records
        )
        return {f"{base_filename}.canvas": canvas.model_dump()}

    # Build parent→children map.
    # NOTE: children_ids is misnamed — it stores a node's PARENT ids (the nodes one
    # level above it), not its children. To find descendants of a node we invert:
    # for each node N, for each pid in N.children_ids, record pid→N as a child.
    parent_to_children: dict = {}
    for node in nodes:
        parent_ids = getattr(node, "children_ids", None) or []
        for pid in parent_ids:
            if pid in id_to_node:
                parent_to_children.setdefault(pid, []).append(node)

    def get_descendants(node_id) -> list:
        result = []
        queue = deque(parent_to_children.get(node_id, []))
        while queue:
            child = queue.popleft()
            result.append(child)
            queue.extend(parent_to_children.get(child.id, []))
        return result

    result_files: dict = {}

    # ── Overview canvas: one file-type node per L2 theme ──────────────────────
    overview_nodes: list = []
    col_x = 0
    for l2 in l2_nodes:
        slug = _slugify(l2.node_name or f"theme_{l2.id}")
        sub_filename = f"{base_filename}_{slug}.canvas"
        dir_prefix = canvas_dir_path.rstrip("/") + "/" if canvas_dir_path else ""
        file_ref = f"{dir_prefix}{sub_filename}"
        overview_nodes.append(
            CanvasNode(
                id=str(l2.id),
                type="file",
                x=col_x,
                y=0,
                width=420,
                height=280,
                file=file_ref,
                label=l2.node_name or "",
            )
        )
        col_x += 500

    # Edges between L2 nodes only
    l2_ids = {n.id for n in l2_nodes}
    overview_edges: list = []
    for rel in relationships:
        if rel.from_node_id in l2_ids and rel.to_node_id in l2_ids:
            rel_type = (rel.relationship_type or "related").lower()
            color = (
                "4" if rel_type in ("supports", "informs", "builds_on", "enables", "affirms")
                else "1" if rel_type in ("contradicts", "opposes", "refutes", "challenges")
                else "3"
            )
            overview_edges.append(
                CanvasEdge(
                    id=f"edge_{rel.id}",
                    fromNode=str(rel.from_node_id),
                    toNode=str(rel.to_node_id),
                    label=rel.relationship_type or "",
                    color=color,
                )
            )

    overview_canvas = ObsidianCanvas(nodes=overview_nodes, edges=overview_edges)
    result_files[f"{base_filename}_overview.canvas"] = overview_canvas.model_dump()

    # ── Per-theme detail canvases ──────────────────────────────────────────────
    for l2 in l2_nodes:
        slug = _slugify(l2.node_name or f"theme_{l2.id}")
        sub_filename = f"{base_filename}_{slug}.canvas"

        descendants = get_descendants(l2.id)
        if not descendants:
            # Include the L2 node itself if it has no children
            descendants = [l2]

        descendant_ids = {n.id for n in descendants}
        sub_node_data = [
            {
                "id": str(n.id),
                "node_name": n.node_name,
                "summary": n.summary,
                "claims": [],
                "key_points": n.key_points or [],
                "predecessor": None,
                "successor": None,
                "contextual_relation": {},
                "linked_nodes": [],
                "is_bookmark": n.is_bookmark,
                "is_contextual_progress": n.is_contextual_progress,
                "chunk_id": str(n.chunk_ids[0]) if n.chunk_ids else None,
                "utterance_ids": [str(uid) for uid in (n.utterance_ids or [])],
            }
            for n in descendants
        ]
        sub_rels = [r for r in relationships if r.from_node_id in descendant_ids and r.to_node_id in descendant_ids]
        sub_rel_records = [
            {
                "id": f"edge_{r.id}",
                "fromNode": str(r.from_node_id),
                "toNode": str(r.to_node_id),
                "label": r.relationship_type or "related",
                "color": "3",
            }
            for r in sub_rels
        ]
        sub_canvas = convert_conversation_to_canvas(
            [sub_node_data], {}, l2.node_name or base_filename, False, edge_records=sub_rel_records
        )
        result_files[sub_filename] = sub_canvas.model_dump()

    logger.info(
        "[HIERARCHICAL CANVAS] Built %d canvas files (%d themes)",
        len(result_files),
        len(l2_nodes),
    )
    return result_files


# ============================================================================
# Route Handlers
# ============================================================================

@router.post("/export/obsidian-canvas/{conversation_id}")
async def export_to_obsidian_canvas(
    conversation_id: str,
    include_chunks: bool = False,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Export a conversation to Obsidian Canvas format.

    Args:
        conversation_id: The ID of the conversation to export
        include_chunks: Whether to include chunk content as separate nodes

    Returns:
        JSON response with Canvas format that can be saved as .canvas file
    """
    try:
        logger.info(f"Exporting conversation {conversation_id} to Obsidian Canvas (include_chunks={include_chunks})")
        conversation_uuid = uuid.UUID(conversation_id)
        conversation, nodes, relationships, utterances = await fetch_conversation_bundle(
            db,
            conversation_uuid,
        )

        if not conversation:
            logger.error(f"Conversation not found: {conversation_id}")
            raise HTTPException(status_code=404, detail="Conversation not found")

        logger.info(f"Found conversation: {conversation.conversation_name}")
        logger.info(f"Found {len(nodes)} nodes")
        logger.info(f"Found {len(relationships)} relationships")
        logger.info(f"Found {len(utterances)} utterances")

        graph_data = build_graph_data_from_nodes(nodes, relationships)
        chunk_dict = build_chunk_dict_from_utterances(utterances) if include_chunks else {}
        canvas_edges = []
        for rel in relationships:
            rel_type = rel.relationship_type or "related"
            rel_type_lower = rel_type.lower()
            if rel_type_lower in ["supports", "informs", "builds_on", "enables", "affirms"]:
                color = "4"
            elif rel_type_lower in ["contradicts", "opposes", "refutes", "challenges", "conflicts", "disagrees", "rebuts"]:
                color = "1"
            else:
                color = "3"
            canvas_edges.append(
                {
                    "id": f"edge_{rel.id}",
                    "fromNode": str(rel.from_node_id),
                    "toNode": str(rel.to_node_id),
                    "label": rel_type,
                    "color": color,
                }
            )

        logger.info(f"Built graph_data with {len(graph_data)} nodes and {len(chunk_dict)} chunks")

        # Use conversation name as file name
        file_name = conversation.conversation_name or "Untitled Conversation"

        # Wrap graph_data in a list for the expected format [[nodes]]
        wrapped_graph_data = [graph_data]

        # Convert to Canvas format (with edges)
        canvas = convert_conversation_to_canvas(
            wrapped_graph_data,
            chunk_dict,
            file_name,
            include_chunks,
            edge_records=canvas_edges
        )

        logger.info(f"Successfully exported conversation to Canvas")
        # Return as JSON (user can save as .canvas file)
        return canvas.model_dump()

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to export conversation to Canvas: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@router.post("/export/obsidian-canvas/{conversation_id}/transcript")
async def export_transcript_artifact(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Export the canonical linear transcript artifact paired with canvas exports."""
    try:
        conversation_uuid = uuid.UUID(conversation_id)
        conversation, _nodes, _relationships, utterances = await fetch_conversation_bundle(db, conversation_uuid)
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        chunk_dict = build_chunk_dict_from_utterances(utterances)
        transcript_text = build_linear_transcript_text(
            conversation=conversation,
            utterances=utterances,
            chunk_dict=chunk_dict,
        )
        base_name = sanitize_artifact_basename(conversation.conversation_name or "conversation")
        return StreamingResponse(
            io.BytesIO(transcript_text.encode("utf-8")),
            media_type="text/plain; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{base_name}.txt"',
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Transcript export failed for %s", conversation_id)
        raise HTTPException(status_code=500, detail=f"Transcript export failed: {exc}")


@router.post("/export/obsidian-canvas/{conversation_id}/hierarchical")
async def export_hierarchical_canvas(
    conversation_id: str,
    canvas_dir_path: str = Query(default="", description="Vault-relative folder path for cross-canvas file references, e.g. 'Conversations/Divij/2026-02-14'"),
    db: AsyncSession = Depends(get_async_session),
):
    """
    Export a conversation as a set of linked Obsidian canvas files (canvas-of-canvases).

    Returns a ZIP archive containing:
    - {name}_overview.canvas  — L2 theme nodes as file-type embeds
    - {name}_{theme}.canvas   — one detail canvas per L2 theme (L3/L4/L5 nodes)

    Falls back to a single flat canvas if the conversation has no hierarchy.
    """
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Node, Relationship

        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        nodes_result = await db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        nodes = list(nodes_result.scalars().all())

        rels_result = await db.execute(
            select(Relationship).where(Relationship.conversation_id == uuid.UUID(conversation_id))
        )
        relationships = list(rels_result.scalars().all())

        base_filename = _slugify(conversation.conversation_name or "conversation", max_len=50)
        canvas_files = build_hierarchical_canvas_set(
            nodes=nodes,
            relationships=relationships,
            base_filename=base_filename,
            canvas_dir_path=canvas_dir_path,
        )

        # Pack all canvas files into a ZIP in memory
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for filename, canvas_data in canvas_files.items():
                zf.writestr(filename, json.dumps(canvas_data, ensure_ascii=False, indent=2))
        zip_buffer.seek(0)

        zip_name = f"{base_filename}_canvas.zip"
        logger.info(
            "[HIERARCHICAL CANVAS] Returning ZIP with %d canvas files for conversation %s",
            len(canvas_files),
            conversation_id,
        )
        return StreamingResponse(
            zip_buffer,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Hierarchical canvas export failed for %s", conversation_id)
        raise HTTPException(status_code=500, detail=f"Hierarchical export failed: {exc}")


@router.post("/import/obsidian-canvas/")
async def import_from_obsidian_canvas(
    request: CanvasImportRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Import an Obsidian Canvas file and save it as a conversation.

    Args:
        request: CanvasImportRequest with canvas_data, file_name, and preserve_positions flag

    Returns:
        SaveJsonResponse with file_id and confirmation
    """
    try:
        # Convert Canvas to conversation format
        graph_data, chunk_dict = convert_canvas_to_conversation(
            request.canvas_data,
            request.preserve_positions
        )

        if not graph_data or not graph_data[0]:
            raise HTTPException(status_code=400, detail="No valid conversation nodes found in Canvas")

        # Generate a new conversation ID
        conversation_id = str(uuid.uuid4())

        # Save to GCS
        result = save_json_to_gcs(
            request.file_name,
            chunk_dict,
            graph_data,
            conversation_id
        )

        # Persist conversation metadata to DB
        number_of_nodes = len(graph_data[0])
        conv_uuid = uuid.UUID(result["file_id"])
        conv = Conversation(
            id=conv_uuid,
            conversation_name=result["file_name"],
            conversation_type="transcript",
            source_type="obsidian_canvas",
            owner_id=resolve_owner_id(),
            started_at=datetime.utcnow(),
            total_nodes=number_of_nodes,
            gcs_path=result["gcs_path"],
        )
        db.add(conv)
        await db.commit()
        logger.info("Canvas import persisted: name=%s nodes=%s", result["file_name"], number_of_nodes)

        return SaveJsonResponse(
            message=f"Successfully imported Canvas as conversation",
            file_id=result["file_id"],
            file_name=result["file_name"]
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to import Canvas: {e}")
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
