"""Conversation read and serialization helpers."""

from typing import Any, Dict, List, Tuple

from sqlalchemy import select

TEMPORAL_RELATIONSHIP_TYPES = {"temporal", "leads_to", "next", "follows"}


async def fetch_conversation_bundle(db, conversation_uuid):
    """Fetch conversation, nodes, relationships, and utterances for a conversation UUID."""
    from lct_python_backend.models import Conversation, Node, Relationship, Utterance

    conversation_result = await db.execute(select(Conversation).where(Conversation.id == conversation_uuid))
    conversation = conversation_result.scalar_one_or_none()

    nodes_result = await db.execute(select(Node).where(Node.conversation_id == conversation_uuid))
    nodes = list(nodes_result.scalars().all())

    relationships_result = await db.execute(
        select(Relationship).where(Relationship.conversation_id == conversation_uuid)
    )
    relationships = list(relationships_result.scalars().all())

    utterances_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    utterances = list(utterances_result.scalars().all())

    return conversation, nodes, relationships, utterances


def build_relationship_maps(nodes, relationships):
    """Build predecessor/successor and contextual lookup maps from relationships."""
    id_to_name = {node.id: node.node_name for node in nodes}
    predecessor_by_id = {}
    successor_by_id = {}
    contextual_by_id = {}
    linked_by_id = {}

    for rel in relationships:
        source_name = id_to_name.get(rel.from_node_id)
        target_name = id_to_name.get(rel.to_node_id)
        if not source_name or not target_name:
            continue

        relationship_type = (rel.relationship_type or "related").strip() or "related"
        rel_type_lower = relationship_type.lower()
        relation_label = rel.explanation or relationship_type

        if rel_type_lower in TEMPORAL_RELATIONSHIP_TYPES:
            successor_by_id[rel.from_node_id] = str(rel.to_node_id)
            predecessor_by_id[rel.to_node_id] = str(rel.from_node_id)
            continue

        contextual_by_id.setdefault(rel.from_node_id, {})[target_name] = relation_label
        linked_by_id.setdefault(rel.from_node_id, set()).add(target_name)

        if rel.is_bidirectional:
            contextual_by_id.setdefault(rel.to_node_id, {})[source_name] = relation_label
            linked_by_id.setdefault(rel.to_node_id, set()).add(source_name)

    linked_by_id = {node_id: sorted(names) for node_id, names in linked_by_id.items()}
    return predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id


def build_graph_data_from_nodes(nodes, relationships, utterances=None) -> List[Dict[str, Any]]:
    """Build frontend graph payload from persisted analyzed nodes + relationships.

    When ``utterances`` is provided, nodes that have no ``timestamp_start`` of
    their own (the common case for older imports) get one derived from the
    earliest utterance they reference. The frontend's audio-seek wiring keys
    off ``timestamp_start``; without this lookup, tapping a node never seeks.

    Two lookup paths, in order: ``node.utterance_ids`` (newer schema),
    falling back to ``node.chunk_ids`` joined via ``utterance.chunk_id``
    (the path that's populated for older imports like the Q.m4a runs).
    """
    predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id = build_relationship_maps(
        nodes,
        relationships,
    )
    utterance_start_by_id: Dict[Any, float] = {}
    utterance_end_by_id: Dict[Any, float] = {}
    chunk_start_by_id: Dict[Any, float] = {}
    chunk_end_by_id: Dict[Any, float] = {}
    if utterances:
        for utt in utterances:
            uid = getattr(utt, "id", None)
            cid = getattr(utt, "chunk_id", None)
            ts = getattr(utt, "timestamp_start", None)
            te = getattr(utt, "timestamp_end", None)
            if uid is not None and ts is not None:
                utterance_start_by_id[uid] = float(ts)
                if te is not None:
                    utterance_end_by_id[uid] = float(te)
            if cid is not None and ts is not None:
                cur_start = chunk_start_by_id.get(cid)
                if cur_start is None or ts < cur_start:
                    chunk_start_by_id[cid] = float(ts)
                if te is not None:
                    cur_end = chunk_end_by_id.get(cid)
                    if cur_end is None or te > cur_end:
                        chunk_end_by_id[cid] = float(te)
    # Build thread_id -> (min_start, max_end) by walking level-1/2 nodes whose
    # timestamps we can derive via chunk_ids. Higher-tier nodes (topic/theme/arc)
    # have no chunk_ids of their own, but share thread_id with their chunks.
    thread_start_by_id: Dict[Any, float] = {}
    thread_end_by_id: Dict[Any, float] = {}
    for node in nodes:
        node_lvl = int(getattr(node, "level", 1) or 1)
        if node_lvl > 2:
            continue
        cluster_info = node.cluster_info or {}
        thread_id = cluster_info.get("thread_id") if isinstance(cluster_info, dict) else None
        if not thread_id:
            continue
        # Reuse the chunk-lookup we just did.
        starts = [chunk_start_by_id[cid] for cid in (node.chunk_ids or []) if cid in chunk_start_by_id]
        ends = [chunk_end_by_id[cid] for cid in (node.chunk_ids or []) if cid in chunk_end_by_id]
        if starts:
            cur_s = thread_start_by_id.get(thread_id)
            min_s = min(starts)
            if cur_s is None or min_s < cur_s:
                thread_start_by_id[thread_id] = min_s
        if ends:
            cur_e = thread_end_by_id.get(thread_id)
            max_e = max(ends)
            if cur_e is None or max_e > cur_e:
                thread_end_by_id[thread_id] = max_e

    id_to_name = {node.id: node.node_name for node in nodes}
    edge_relations_by_id = {}
    for rel in relationships:
        if rel.relationship_type in TEMPORAL_RELATIONSHIP_TYPES:
            continue
        target_name = id_to_name.get(rel.from_node_id)
        if not target_name:
            continue
        edge_relations_by_id.setdefault(rel.to_node_id, []).append(
            {
                "related_node": target_name,
                "relation_type": rel.relationship_type or "contextual",
                "relation_text": rel.explanation or rel.relationship_type or "related",
            }
        )

    graph_data = []
    for node in nodes:
        contextual_relation = contextual_by_id.get(node.id, {})
        linked_nodes = linked_by_id.get(node.id, sorted(contextual_relation.keys()))
        cluster_info = node.cluster_info or {}
        display_preferences = node.display_preferences or {}
        # ADR-021 / ADR-030 §P5: surface authored hierarchy fields so
        # MinimalGraph.getAuthoredSemanticLevel() actually fires. Without
        # these, the frontend silently falls back to legacy clustering
        # heuristics and the chunk/idea/topic/theme tabs never light up.
        node_level = int(node.level or 1)
        node_level = max(1, min(5, node_level))
        _SEMANTIC_TYPE_BY_LEVEL = {
            1: "chunk", 2: "idea", 3: "topic", 4: "theme", 5: "arc",
        }
        derived_start = None
        derived_end = None
        if node.timestamp_start is None:
            # Try utterance_ids first (newer schema).
            if utterance_start_by_id and node.utterance_ids:
                starts = [
                    utterance_start_by_id[uid]
                    for uid in node.utterance_ids
                    if uid in utterance_start_by_id
                ]
                ends = [
                    utterance_end_by_id[uid]
                    for uid in node.utterance_ids
                    if uid in utterance_end_by_id
                ]
                if starts:
                    derived_start = min(starts)
                if ends:
                    derived_end = max(ends)
            # Fall back to chunk_ids -> utterances grouped by chunk_id.
            if derived_start is None and chunk_start_by_id and node.chunk_ids:
                chunk_starts = [
                    chunk_start_by_id[cid]
                    for cid in node.chunk_ids
                    if cid in chunk_start_by_id
                ]
                chunk_ends = [
                    chunk_end_by_id[cid]
                    for cid in node.chunk_ids
                    if cid in chunk_end_by_id
                ]
                if chunk_starts:
                    derived_start = min(chunk_starts)
                if chunk_ends:
                    derived_end = max(chunk_ends)
            # Topic/theme/arc nodes have no chunk_ids of their own. They share
            # thread_id with their descendant chunks, which we've indexed above.
            if derived_start is None:
                ci = node.cluster_info or {}
                tid = ci.get("thread_id") if isinstance(ci, dict) else None
                if tid and tid in thread_start_by_id:
                    derived_start = thread_start_by_id[tid]
                    derived_end = thread_end_by_id.get(tid, derived_start)
            # Final fallback: conversation-wide min/max. Mostly for arc nodes
            # which synthesize the whole conversation and have no thread_id.
            if derived_start is None and chunk_start_by_id:
                derived_start = min(chunk_start_by_id.values())
                if chunk_end_by_id:
                    derived_end = max(chunk_end_by_id.values())
        effective_start = node.timestamp_start if node.timestamp_start is not None else derived_start
        effective_end = node.timestamp_end if node.timestamp_end is not None else derived_end
        node_data = {
            "id": str(node.id),
            "node_name": node.node_name,
            "summary": node.summary,
            "semantic_level": node_level,
            "semantic_type": _SEMANTIC_TYPE_BY_LEVEL[node_level],
            "level": node_level,  # legacy alias for back-compat
            "claims": [str(cid) for cid in (node.claim_ids or [])],
            "key_points": node.key_points or [],
            "predecessor": (
                str(node.predecessor_id) if node.predecessor_id else predecessor_by_id.get(node.id)
            ),
            "successor": str(node.successor_id) if node.successor_id else successor_by_id.get(node.id),
            "contextual_relation": contextual_relation,
            "linked_nodes": linked_nodes,
            "is_bookmark": node.is_bookmark,
            "is_contextual_progress": node.is_contextual_progress,
            "is_tangent": node.is_tangent,
            "is_crux": getattr(node, "is_crux", False),
            "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
            "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
            "thread_id": cluster_info.get("thread_id"),
            "thread_state": cluster_info.get("thread_state"),
            "edge_relations": edge_relations_by_id.get(node.id, display_preferences.get("edge_relations") or []),
            "speaker_id": (node.speaker_info or {}).get("primary_speaker") or None,
            **({"timestamp_start": effective_start} if effective_start is not None else {}),
            **({"timestamp_end": effective_end} if effective_end is not None else {}),
        }
        graph_data.append(node_data)

    return graph_data


def build_chunk_dict_from_utterances(utterances) -> Dict[str, str]:
    """Build chunk dictionary expected by frontend conversation view.

    Nodes carry ``chunk_id`` as the UUID of their owning chunk. The
    frontend's NodeDetail panel looks up ``chunkDict[node.chunk_id]`` to
    render the diarized "speaker: text" lines for that chunk. Keying the
    whole transcript under a single ``"default_chunk"`` bucket (the prior
    behaviour) meant every UUID lookup missed, so tapping a node never
    showed any raw transcript.

    We now bucket utterances by ``utterance.chunk_id`` and stringify the
    UUID to match what the frontend sends. The legacy ``"default_chunk"``
    key still gets populated (with everything) as a back-compat fallback
    and for any utterance whose ``chunk_id`` is NULL.
    """
    if not utterances:
        return {}

    by_chunk: Dict[str, List[str]] = {}
    all_lines: List[str] = []
    for utt in utterances:
        speaker = getattr(utt, "speaker_name", None) or getattr(utt, "speaker_id", None) or ""
        text = getattr(utt, "text", "") or ""
        line = f"{speaker}: {text}" if speaker else text
        all_lines.append(line)
        chunk_uuid = getattr(utt, "chunk_id", None)
        bucket_key = str(chunk_uuid) if chunk_uuid is not None else "default_chunk"
        by_chunk.setdefault(bucket_key, []).append(line)

    result: Dict[str, str] = {key: "\n".join(lines) for key, lines in by_chunk.items()}
    # Always keep the legacy default_chunk fallback so older frontends or
    # nodes with NULL chunk_ids still resolve to something.
    result.setdefault("default_chunk", "\n".join(all_lines))
    return result


def wrap_graph_data_chunks(graph_data: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Wrap graph data in nested chunk structure expected by frontend."""
    return [graph_data] if graph_data else []


def serialize_utterances(utterances) -> List[Dict[str, Any]]:
    """Serialize utterance rows for timeline API payload."""
    return [
        {
            "id": str(utterance.id),
            "conversation_id": str(utterance.conversation_id),
            "sequence_number": utterance.sequence_number,
            "speaker_id": utterance.speaker_id,
            "speaker_name": utterance.speaker_name,
            "speaker_source": getattr(utterance, "speaker_source", None),
            "speaker_confidence": getattr(utterance, "speaker_confidence", None),
            "speaker_revision": getattr(utterance, "speaker_revision", None),
            "text": utterance.text,
            "timestamp_start": utterance.timestamp_start,
            "timestamp_end": utterance.timestamp_end,
            "duration_seconds": utterance.duration_seconds,
        }
        for utterance in utterances
    ]
