"""Obsidian Canvas export/import API endpoints."""
import logging
import uuid
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.db_helpers import insert_conversation_metadata
from lct_python_backend.schemas import SaveJsonResponse
from lct_python_backend.services.gcs_helpers import save_json_to_gcs

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

    # Extract nodes from graph_data (format is [[nodes]])
    conversation_nodes = graph_data[0] if graph_data and isinstance(graph_data[0], list) else []

    if not conversation_nodes:
        raise ValueError("No nodes found in conversation data")

    # Build node position map using hierarchical layout
    node_positions = {}
    node_map = {node["node_name"]: node for node in conversation_nodes}

    # Find root nodes (nodes without predecessors)
    root_nodes = [node for node in conversation_nodes if not node.get("predecessor")]

    # Simple hierarchical layout algorithm
    NODE_WIDTH = 350
    NODE_HEIGHT = 200
    # Spacing: horizontal = 2x node width, vertical = 3x node height
    HORIZONTAL_SPACING = 2 * NODE_WIDTH  # 700px = 350px gap between nodes
    VERTICAL_SPACING = 3 * NODE_HEIGHT   # 600px = 400px gap between nodes

    def calculate_positions(current_node, x, y, visited):
        """Recursively calculate positions for nodes"""
        node_name = current_node["node_name"]

        if node_name in visited:
            return y

        visited.add(node_name)
        node_positions[node_name] = {"x": x, "y": y}

        # Find successor
        successor_name = current_node.get("successor")
        if successor_name and successor_name in node_map:
            successor = node_map[successor_name]
            y = calculate_positions(successor, x + HORIZONTAL_SPACING, y, visited)
        else:
            y += VERTICAL_SPACING

        return y

    # Calculate positions starting from root nodes
    visited = set()
    current_y = 100
    for root in root_nodes:
        current_y = calculate_positions(root, 100, current_y, visited)

    # Handle orphan nodes (nodes not connected to any root)
    orphan_x = 100
    orphan_y = current_y + VERTICAL_SPACING
    for node in conversation_nodes:
        if node["node_name"] not in visited:
            node_positions[node["node_name"]] = {"x": orphan_x, "y": orphan_y}
            orphan_x += HORIZONTAL_SPACING
            if orphan_x > 2000:  # Wrap to next row
                orphan_x = 100
                orphan_y += VERTICAL_SPACING

    # Create Canvas nodes
    for node in conversation_nodes:
        node_name = node["node_name"]
        position = node_positions.get(node_name, {"x": 100, "y": 100})

        # Determine node color based on flags
        color = None
        if node.get("is_bookmark"):
            color = "5"  # Cyan/Blue for bookmarks
        elif node.get("is_contextual_progress"):
            color = "4"  # Green for contextual progress

        # Build node text content with markdown
        text_content = f"# {node_name}\n\n"
        text_content += f"{node.get('summary', '')}\n\n"

        if node.get("claims"):
            text_content += "## Claims\n"
            for claim in node["claims"]:
                text_content += f"- {claim}\n"
            text_content += "\n"

        if node.get("chunk_id") and not include_chunks:
            text_content += f"*Chunk ID: {node['chunk_id']}*\n"

        # Calculate height based on text length (rough estimate)
        estimated_height = max(NODE_HEIGHT, min(600, len(text_content) // 3))

        canvas_node = CanvasNode(
            id=node_name.replace(" ", "_"),
            type="text",
            x=position["x"],
            y=position["y"],
            width=NODE_WIDTH,
            height=estimated_height,
            color=color,
            text=text_content
        )
        nodes.append(canvas_node)

    # Create edges: first from supplied edge_records (relationships), then fallback temporal/contextual
    edge_counter = 0
    created_edges = set()

    def add_edge(from_id: str, to_id: str, label: str, color: str, from_side=None, to_side=None, from_end="none", to_end="arrow"):
        nonlocal edge_counter
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

    # Inject edges provided via edge_records (relationships)
    if edge_records:
        for rec in edge_records:
            source = rec.get("fromNode") or rec.get("from") or rec.get("source")
            target = rec.get("toNode") or rec.get("to") or rec.get("target")
            label = rec.get("label") or rec.get("type") or "related"
            color = rec.get("color") or "3"
            if source and target:
                add_edge(source, target, label, color, from_end="none", to_end="arrow")

    # Fallback: temporal/contextual relationships derived from graph_data
    for node in conversation_nodes:
        node_id = node["node_name"].replace(" ", "_")

        # Temporal edge (successor)
        if node.get("successor"):
            successor_id = node["successor"].replace(" ", "_")
            add_edge(node_id, successor_id, "next", "1", from_side="right", to_side="left", to_end="arrow")

        # Contextual relationships
        if node.get("contextual_relation"):
            for related_node_name, explanation in node["contextual_relation"].items():
                related_id = related_node_name.replace(" ", "_")
                label = explanation[:50] + "..." if len(explanation) > 50 else explanation
                add_edge(node_id, related_id, label or "related", "3", from_end="none", to_end="none")

    # Add chunk nodes if requested
    if include_chunks:
        chunk_y = max([pos["y"] for pos in node_positions.values()], default=0) + VERTICAL_SPACING * 2
        chunk_x = 100

        for chunk_id, chunk_text in chunk_dict.items():
            canvas_node = CanvasNode(
                id=f"chunk_{chunk_id}",
                type="text",
                x=chunk_x,
                y=chunk_y,
                width=NODE_WIDTH,
                height=300,
                color="6",  # Purple for chunks
                text=f"# Chunk: {chunk_id}\n\n{chunk_text[:500]}..."  # Truncate long chunks
            )
            nodes.append(canvas_node)

            # Link chunk to related conversation nodes
            for node in conversation_nodes:
                if node.get("chunk_id") == chunk_id:
                    node_id = node["node_name"].replace(" ", "_")
                    edge = CanvasEdge(
                        id=f"edge_{edge_counter}",
                        fromNode=node_id,
                        toNode=f"chunk_{chunk_id}",
                        fromEnd="none",
                        toEnd="none",
                        color="2",  # Orange for chunk links
                        label="references"
                    )
                    edges.append(edge)
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
        # Temporal edges have "next" label or are red (color "1")
        if edge.label == "next" or edge.color == "1":
            temporal_edges[edge.fromNode] = edge.toNode
        # Chunk reference edges
        elif edge.label == "references" or edge.color == "2":
            continue  # Skip chunk reference edges for now
        # Contextual edges
        else:
            if edge.fromNode not in contextual_edges:
                contextual_edges[edge.fromNode] = []
            contextual_edges[edge.fromNode].append((edge.toNode, edge.label or "Related"))

    # Process nodes
    for node in canvas.nodes:
        # Skip non-text nodes and chunk nodes
        if node.type != "text" or node.id.startswith("chunk_"):
            if node.id.startswith("chunk_"):
                # Extract chunk content
                chunk_id = node.id.replace("chunk_", "")
                chunk_dict[chunk_id] = node.text or ""
            continue

        # Extract node name from ID (reverse the replacement)
        node_name = node.id.replace("_", " ")

        # Parse text content to extract summary and other fields
        text = node.text or ""
        lines = text.split("\n")

        # Extract title (first line after #)
        title = node_name
        if lines and lines[0].startswith("#"):
            title = lines[0].replace("#", "").strip()

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
                predecessor = from_id.replace("_", " ")
                break

        # Find successor
        successor = temporal_edges.get(node.id)
        if successor:
            successor = successor.replace("_", " ")

        # Build contextual_relation map
        contextual_relation = {}
        linked_nodes = []
        if node.id in contextual_edges:
            for target_id, label in contextual_edges[node.id]:
                target_name = target_id.replace("_", " ")
                contextual_relation[target_name] = label
                linked_nodes.append(target_name)

        # Also check reverse edges
        for from_id, edges_list in contextual_edges.items():
            for target_id, label in edges_list:
                if target_id == node.id:
                    source_name = from_id.replace("_", " ")
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
        print(f"[INFO] Exporting conversation {conversation_id} to Obsidian Canvas (include_chunks={include_chunks})")

        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Node, Utterance, Relationship

        # Fetch conversation from PostgreSQL
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            print(f"[ERROR] Conversation not found: {conversation_id}")
            raise HTTPException(status_code=404, detail="Conversation not found")

        print(f"[INFO] Found conversation: {conversation.conversation_name}")

        # Fetch all nodes for this conversation
        nodes_result = await db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        nodes = list(nodes_result.scalars().all())
        print(f"[INFO] Found {len(nodes)} nodes")

        # Fetch all relationships for this conversation
        relationships_result = await db.execute(
            select(Relationship).where(Relationship.conversation_id == uuid.UUID(conversation_id))
        )
        relationships = list(relationships_result.scalars().all())
        print(f"[INFO] Found {len(relationships)} relationships")

        # Fetch all utterances for this conversation
        utterances_result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = list(utterances_result.scalars().all())
        print(f"[INFO] Found {len(utterances)} utterances")

        # Build graph_data from nodes
        graph_data = []
        chunk_dict = {}

        # Create mapping from node ID to node name
        id_to_name = {node.id: node.node_name for node in nodes}

        # Build relationship data structures (and collect edges for Canvas)
        successor_map = {}           # node_id -> successor_node_name
        contextual_map = {}          # node_id -> {related_node_name: relationship_type}
        canvas_edges = []            # edges to emit in canvas

        for rel in relationships:
            from_name = id_to_name.get(rel.from_node_id)
            to_name = id_to_name.get(rel.to_node_id)

            if not from_name or not to_name:
                continue

            rel_type = rel.relationship_type or "related"
            rel_type_lower = rel_type.lower()

            # Check relationship type to determine if it's temporal (successor) or contextual
            if rel_type_lower in ['leads_to', 'next', 'follows']:
                successor_map[rel.from_node_id] = to_name
            else:
                if rel.from_node_id not in contextual_map:
                    contextual_map[rel.from_node_id] = {}
                contextual_map[rel.from_node_id][to_name] = rel_type

            # Map to Canvas edge color: 1=red (temporal here unused), 2=orange (chunks), 3=neutral, 4=green
            if rel_type_lower in ["supports", "informs", "builds_on", "enables", "affirms"]:
                color = "4"  # green
            elif rel_type_lower in ["contradicts", "opposes", "refutes", "challenges", "conflicts", "disagrees"]:
                color = "1"  # red
            elif rel_type_lower in ["leads_to", "next", "follows"]:
                color = "3"  # neutral for temporal
            else:
                color = "3"  # neutral/default

            canvas_edges.append({
                "id": f"edge_{rel.id}",
                "fromNode": str(rel.from_node_id),
                "toNode": str(rel.to_node_id),
                "label": rel_type,
                "color": color,
            })

        for node in nodes:
            node_data = {
                "id": str(node.id),
                "node_name": node.node_name,
                "summary": node.summary,
                "claims": [str(cid) for cid in (node.claim_ids or [])],
                "key_points": node.key_points or [],
                "predecessor": None,  # Will be computed from successor relationships
                "successor": successor_map.get(node.id),
                "contextual_relation": contextual_map.get(node.id, {}),
                "linked_nodes": [],
                "is_bookmark": node.is_bookmark,
                "is_contextual_progress": node.is_contextual_progress,
                "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
                "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])]
            }
            graph_data.append(node_data)

            # Build chunk_dict if including chunks
            if include_chunks and node.chunk_ids:
                for chunk_id in node.chunk_ids:
                    chunk_id_str = str(chunk_id)
                    if chunk_id_str not in chunk_dict:
                        # Get utterances for this chunk
                        chunk_utterances = [
                            utt for utt in utterances
                            if utt.chunk_id and str(utt.chunk_id) == chunk_id_str
                        ]
                        # Combine utterance texts
                        chunk_text = "\n".join([utt.text for utt in chunk_utterances])
                        chunk_dict[chunk_id_str] = chunk_text

        print(f"[INFO] Built graph_data with {len(graph_data)} nodes and {len(chunk_dict)} chunks")

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

        print(f"[INFO] Successfully exported conversation to Canvas")
        # Return as JSON (user can save as .canvas file)
        return canvas.model_dump()

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to export conversation to Canvas: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@router.post("/import/obsidian-canvas/")
async def import_from_obsidian_canvas(request: CanvasImportRequest):
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

        # Insert metadata into DB
        number_of_nodes = len(graph_data[0])
        metadata = {
            "id": result["file_id"],
            "conversation_name": result["file_name"],  # Database column is conversation_name
            "total_nodes": number_of_nodes,
            "gcs_path": result["gcs_path"],
            "created_at": datetime.utcnow()
        }
        print(f"[DEBUG] Canvas import - Inserting metadata: conversation_name={result['file_name']}, total_nodes={number_of_nodes}")

        await insert_conversation_metadata(metadata)

        return SaveJsonResponse(
            message=f"Successfully imported Canvas as conversation",
            file_id=result["file_id"],
            file_name=result["file_name"]
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to import Canvas: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
