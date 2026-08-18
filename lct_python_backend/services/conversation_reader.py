"""Conversation read and serialization helpers."""

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select

TEMPORAL_RELATIONSHIP_TYPES = {"temporal", "leads_to", "next", "follows"}
MEMBERSHIP_RELATIONSHIP_TYPE = "member_of"


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

        # Membership edges are canonical hierarchy facts, not contextual links.
        # They are serialized separately as ``memberships`` below so the viewer
        # can project one zoom tree without erasing secondary memberships.
        if rel_type_lower == MEMBERSHIP_RELATIONSHIP_TYPE:
            continue

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


def build_memberships_by_child(nodes, relationships):
    """Return canonical many-to-many memberships keyed by child node id.

    ``member_of`` relationships point child -> parent.  Their subtype encodes
    ``<lens>:<role>`` (currently ``thematic:primary|secondary``).  The legacy
    ``Node.parent_id`` / ``children_ids`` fields remain a single zoom-view
    projection and are intentionally not used to reconstruct this richer map.
    """
    node_ids = {node.id for node in nodes}
    memberships_by_child: Dict[Any, List[Dict[str, Any]]] = {}
    seen = set()

    for rel in relationships:
        relationship_type = (rel.relationship_type or "").strip().lower()
        if relationship_type != MEMBERSHIP_RELATIONSHIP_TYPE:
            continue
        if rel.from_node_id not in node_ids or rel.to_node_id not in node_ids:
            continue

        subtype = str(rel.relationship_subtype or "thematic:secondary").strip()
        lens, separator, role = subtype.partition(":")
        lens = lens or "thematic"
        role = role if separator and role in {"primary", "secondary"} else "secondary"
        key = (rel.from_node_id, rel.to_node_id, lens)
        if key in seen:
            continue
        seen.add(key)
        memberships_by_child.setdefault(rel.from_node_id, []).append(
            {
                "parent_id": str(rel.to_node_id),
                "lens": lens,
                "role": role,
                "confidence": rel.confidence,
            }
        )

    for memberships in memberships_by_child.values():
        memberships.sort(
            key=lambda item: (
                item["role"] != "primary",
                item["lens"],
                item["parent_id"],
            )
        )
    return memberships_by_child


def _compute_source_ref(node, seq_by_id, srcid_by_id):
    """Provenance anchor for a node (P0): prefer the persisted ``Node.source_ref``,
    else derive a DETERMINISTIC read-model from the node's persisted
    ``utterance_ids`` so legacy graphs are auditable too — it can't drift because
    it's re-derived from the source-of-truth ids each time. Returns ``None`` when
    the node references no utterances (viewer treats null as 'unauditable' rather
    than faking coverage). Shape: {utterance_ids, source_identifiers, start_seq,
    end_seq}."""
    persisted = getattr(node, "source_ref", None)
    if persisted:
        return persisted
    uids = list(getattr(node, "utterance_ids", None) or [])
    if not uids:
        return None
    seqs = [seq_by_id[u] for u in uids if u in seq_by_id]
    srcids = [srcid_by_id[u] for u in uids if u in srcid_by_id]
    return {
        "utterance_ids": [str(u) for u in uids],
        "source_identifiers": srcids,
        "start_seq": min(seqs) if seqs else None,
        "end_seq": max(seqs) if seqs else None,
    }


def build_graph_data_from_nodes(
    nodes, relationships, utterances=None, include_edges_out=False
) -> List[Dict[str, Any]]:
    """Build frontend graph payload from persisted analyzed nodes + relationships.

    ``include_edges_out=True`` adds an ``edges_out`` list to every node — its
    outgoing Relationship rows verbatim (id + every field). ``persist_graph``
    consumes that for a lossless DB-graph -> reconstruct -> re-persist
    round-trip; default-off keeps read/export payloads lean.

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
    memberships_by_child = build_memberships_by_child(nodes, relationships)
    utterance_start_by_id: Dict[Any, float] = {}
    utterance_end_by_id: Dict[Any, float] = {}
    chunk_start_by_id: Dict[Any, float] = {}
    chunk_end_by_id: Dict[Any, float] = {}
    # P0 provenance: uid -> sequence_number / IndrasNet source_identifier, so each
    # node's source_ref can name the exact raw turns + their span.
    utterance_seq_by_id: Dict[Any, int] = {}
    utterance_srcid_by_id: Dict[Any, str] = {}
    # Conversation-wide min/max — used as a fallback for live-recorded
    # conversations where the live-STT write path never linked
    # utterance.chunk_id to node.chunk_ids. The graph nodes exist, the
    # utterances exist, but nothing joins them. Better to seek to the
    # start of the conversation than to fail silently.
    convo_min_start: Optional[float] = None
    convo_max_end: Optional[float] = None
    if utterances:
        for utt in utterances:
            uid = getattr(utt, "id", None)
            cid = getattr(utt, "chunk_id", None)
            ts = getattr(utt, "timestamp_start", None)
            te = getattr(utt, "timestamp_end", None)
            if uid is not None:
                seqn = getattr(utt, "sequence_number", None)
                if seqn is not None:
                    utterance_seq_by_id[uid] = int(seqn)
                srcid = getattr(utt, "source_identifier", None)
                if srcid:
                    utterance_srcid_by_id[uid] = srcid
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
            if ts is not None:
                if convo_min_start is None or ts < convo_min_start:
                    convo_min_start = float(ts)
                if te is not None and (convo_max_end is None or te > convo_max_end):
                    convo_max_end = float(te)
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
        relationship_type = (rel.relationship_type or "").strip().lower()
        if (
            relationship_type in TEMPORAL_RELATIONSHIP_TYPES
            or relationship_type == MEMBERSHIP_RELATIONSHIP_TYPE
        ):
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

    # Faithful per-node outgoing-edge list. Off by default — read/export
    # callers don't need it. Re-persist callers (migrations, the round-trip
    # verifier) pass include_edges_out=True so persist_graph can rewrite every
    # Relationship row verbatim (id + all fields) instead of re-deriving edges
    # from the lossy singular predecessor/successor/contextual fields.
    edges_out_by_id: Dict[Any, List[Dict[str, Any]]] = {}
    if include_edges_out:
        for rel in relationships:
            edges_out_by_id.setdefault(rel.from_node_id, []).append({
                "id": str(rel.id),
                "to": str(rel.to_node_id),
                "relationship_type": rel.relationship_type,
                "relationship_subtype": rel.relationship_subtype,
                "explanation": rel.explanation,
                "strength": rel.strength,
                "confidence": rel.confidence,
                "is_bidirectional": bool(getattr(rel, "is_bidirectional", False)),
                "supporting_utterance_ids": [
                    str(u) for u in (getattr(rel, "supporting_utterance_ids", None) or [])
                ],
            })

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
            # which synthesize the whole conversation and have no thread_id,
            # AND for live-recorded conversations where the live-STT path
            # never linked utterances to node chunk_ids (no join possible
            # via any of the above paths).
            if derived_start is None:
                if chunk_start_by_id:
                    derived_start = min(chunk_start_by_id.values())
                    if chunk_end_by_id:
                        derived_end = max(chunk_end_by_id.values())
                elif convo_min_start is not None:
                    derived_start = convo_min_start
                    derived_end = convo_max_end if convo_max_end is not None else convo_min_start
        effective_start = node.timestamp_start if node.timestamp_start is not None else derived_start
        effective_end = node.timestamp_end if node.timestamp_end is not None else derived_end

        # Conversation-dimension markers. action_item/surprise/tangent/crux are
        # node booleans; agreement/disagreement are DERIVED from edges (ADR-032:
        # supports == agreement, rebuts == disagreement) — edges stay canonical.
        # The viewer reads the single `markers` array (future-proof for new
        # dimensions like claim-type/fallacy); the booleans remain for back-compat.
        _node_edges = edge_relations_by_id.get(
            node.id, display_preferences.get("edge_relations") or []
        )
        _edge_types = {
            str(e.get("relation_type") or "").lower()
            for e in _node_edges if isinstance(e, dict)
        }
        _has_agreement = bool(_edge_types & {"supports", "agrees", "agreement"})
        _has_disagreement = bool(_edge_types & {"rebuts", "disagrees", "disagreement"})
        _markers = [
            name for name, on in (
                ("crux", getattr(node, "is_crux", False)),
                ("action_item", getattr(node, "is_action_item", False)),
                ("disagreement", _has_disagreement),
                ("agreement", _has_agreement),
                ("surprise", getattr(node, "is_surprise", False)),
                ("tangent", node.is_tangent),
                ("bookmark", node.is_bookmark),
                ("contextual_progress", node.is_contextual_progress),
            ) if on
        ]
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
            "is_action_item": getattr(node, "is_action_item", False),
            "is_surprise": getattr(node, "is_surprise", False),
            "has_agreement": _has_agreement,
            "has_disagreement": _has_disagreement,
            "markers": _markers,
            "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
            "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
            "parent_id": str(node.parent_id) if node.parent_id else None,
            "children_ids": [str(cid) for cid in (node.children_ids or [])],
            # Canonical hierarchy is a cover (many-to-many). ``parent_id`` and
            # ``children_ids`` above are the primary thematic zoom projection.
            "memberships": memberships_by_child.get(node.id, []),
            # ADR-032 Part G: surface persisted source_excerpt so re-persist
            # round-trips preserve it. Without this the enrich/consolidate
            # scripts wipe it when they call build_graph_data_from_nodes
            # then re-feed into persist_graph.
            "source_excerpt": node.source_excerpt,
            # P0 provenance: the auditable link to exact raw turns (display
            # snippet above is NOT provenance). Feeds the Coverage Report +
            # NodeDetail Provenance panel; survives the re-persist round-trip.
            "source_ref": _compute_source_ref(node, utterance_seq_by_id, utterance_srcid_by_id),
            "thread_id": cluster_info.get("thread_id"),
            "thread_label": cluster_info.get("thread_label"),
            "thread_state": cluster_info.get("thread_state"),
            "edge_relations": _node_edges,
            # Argument-map role (claim | evidence | question | assumption) —
            # persisted in display_preferences (no column); feeds the frontend
            # rhetoric/debate color mode + the per-card claim-type chip.
            "argument_role": (
                display_preferences.get("argument_role")
                or display_preferences.get("claim_type")
            ),
            "speaker_id": (node.speaker_info or {}).get("primary_speaker") or None,
            **({"timestamp_start": effective_start} if effective_start is not None else {}),
            **({"timestamp_end": effective_end} if effective_end is not None else {}),
            **({"edges_out": edges_out_by_id.get(node.id, [])} if include_edges_out else {}),
        }
        graph_data.append(node_data)

    # ADR-032 Part C: the previous read-time temporal-chain synthesis
    # (f761f8d, removed in commit referenced below) is GONE. Temporal info
    # lives on node.timestamp_start for swim-lane positioning. Edges in
    # the API output now contain ONLY semantically authored relationships
    # (supports / rebuts / clarifies / etc) plus any LLM-authored
    # predecessor/successor that came through the DB. Don't double-emit
    # the chain that timestamp_start already encodes — attention is
    # scarce; edges must be meaningful.

    return graph_data


def build_chunk_dict_from_utterances(utterances, node_chunk_ids=None) -> Dict[str, str]:
    """Build chunk dictionary expected by frontend conversation view.

    Nodes carry ``chunk_id`` as the UUID of their owning chunk. The
    frontend's NodeDetail panel looks up ``chunkDict[node.chunk_id]`` to
    render the diarized "speaker: text" lines for that chunk. Keying the
    whole transcript under a single ``"default_chunk"`` bucket (the prior
    behaviour) meant every UUID lookup missed, so tapping a node never
    showed any raw transcript.

    We bucket utterances by ``utterance.chunk_id`` (stringified) when
    that link is populated — this is the import / Q.m4a path.

    When NO utterances have ``chunk_id`` populated (the live-STT writer
    skips this column), we fall back: every node's ``chunk_id`` gets a
    copy of the entire conversation transcript. Coarse, but it means the
    side panel actually shows the conversation text instead of empty
    space when you tap a node from a live-recorded session.

    ``node_chunk_ids`` is an optional iterable of node chunk_id UUIDs.
    Pass it from the caller when you have the node list to seed the
    fallback. If omitted, only the ``default_chunk`` legacy key is set.
    """
    if not utterances:
        return {}

    by_chunk: Dict[str, List[str]] = {}
    all_lines: List[str] = []
    any_chunk_id_populated = False
    for utt in utterances:
        speaker = getattr(utt, "speaker_name", None) or getattr(utt, "speaker_id", None) or ""
        text = getattr(utt, "text", "") or ""
        line = f"{speaker}: {text}" if speaker else text
        all_lines.append(line)
        chunk_uuid = getattr(utt, "chunk_id", None)
        if chunk_uuid is not None:
            any_chunk_id_populated = True
            bucket_key = str(chunk_uuid)
        else:
            bucket_key = "default_chunk"
        by_chunk.setdefault(bucket_key, []).append(line)

    result: Dict[str, str] = {key: "\n".join(lines) for key, lines in by_chunk.items()}
    # Always keep the legacy default_chunk fallback so older frontends or
    # nodes with NULL chunk_ids still resolve to something.
    result.setdefault("default_chunk", "\n".join(all_lines))

    # Live-STT fallback: utterances had no chunk_id, but the graph nodes
    # do. Copy the full transcript under every node's chunk_id so the
    # frontend lookup hits.
    if not any_chunk_id_populated and node_chunk_ids:
        full_text = "\n".join(all_lines)
        for cid in node_chunk_ids:
            if cid is None:
                continue
            key = str(cid)
            result.setdefault(key, full_text)

    return result


def wrap_graph_data_chunks(graph_data: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Wrap graph data in nested chunk structure expected by frontend."""
    return [graph_data] if graph_data else []


def build_full_transcript_for_export(utterances) -> str:
    """Reconstruct the verbatim, speaker-tagged transcript from utterance rows,
    ordered by sequence_number.

    P0 (no-arbitrary-compression): this is the lossless raw the graph was built
    from, bundled into the .threads so the map can always be AUDITED against
    source — unlike chunk source_excerpts (representative snippets) or the lossy
    chunk_dict full-text duplication. Built only from existing fields (text,
    sequence_number, speaker), so no schema change is required.
    """
    if not utterances:
        return ""
    ordered = sorted(
        utterances,
        key=lambda u: (u.sequence_number if u.sequence_number is not None else 10 ** 18),
    )
    lines: List[str] = []
    for u in ordered:
        text = (u.text or "").strip()
        if not text:
            continue
        speaker = getattr(u, "speaker_name", None) or u.speaker_id or "?"
        lines.append(f"[{speaker}] {text}")
    return "\n".join(lines)


def build_coverage_summary(graph_data, utterances) -> Dict[str, Any]:
    """How much of the raw the graph actually covers (P0 quality check).

    covered = the union of every node's ``source_ref.utterance_ids``, INTERSECTED
    with the ids that were actually persisted; total = the utterance count.
    ``auditable`` is False (``pct`` = None) when NO node carries provenance
    (legacy / live-STT unlinked conversations) — the viewer then shows
    "unauditable" rather than faking a coverage number. This is the honest
    graph-vs-source check the owner asked for.
    """
    def _utt_id(u: Any) -> Optional[str]:
        # Tolerate ORM rows (u.id), serialized dicts (u["id"]), and test mocks.
        # Utterances with no id stay in `total` (they are real turns) but can
        # never be matched, so they are simply unmatchable, not counted covered.
        raw = getattr(u, "id", None)
        if raw is None and isinstance(u, dict):
            raw = u.get("id")
        return str(raw) if raw is not None else None

    persisted_ids = {sid for sid in (_utt_id(u) for u in (utterances or [])) if sid is not None}
    total = len(utterances or [])
    covered = set()
    for node in graph_data or []:
        source_ref = node.get("source_ref") or {}
        for uid in (source_ref.get("utterance_ids") or []):
            sid = str(uid)
            # Only count utterances that actually exist. A node can carry an id
            # for an utterance that was never persisted (a dropped empty-text row,
            # or an authored/hallucinated id); counting it would over-report —
            # pct could exceed 100 or `auditable` could be faked. codex PR#63.
            if sid in persisted_ids:
                covered.add(sid)
    n_covered = len(covered)
    auditable = n_covered > 0
    pct = round(100.0 * n_covered / total, 1) if (auditable and total) else None
    return {
        "total_turns": total,
        "covered_turns": n_covered,
        "pct": pct,
        "auditable": auditable,
    }


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
