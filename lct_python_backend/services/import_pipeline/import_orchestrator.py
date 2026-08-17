"""
Import orchestration — parse, validate, and persist transcripts.

Consolidates the duplicated parse→validate→persist flow that was repeated
across three import endpoints (file upload, URL, pasted text).
"""

import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.graph_persistence import persist_transcript

logger = logging.getLogger(__name__)

ARGUMENT_TOPOLOGY_SCAN_VERSION = "1.0"


def _safe_text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _is_local_provider(provider: Any) -> bool:
    from lct_python_backend.services.egress_guard import is_local_url

    return bool(
        isinstance(provider, dict)
        and provider.get("enabled", True)
        and _safe_text(provider.get("base_url"))
        and is_local_url(_safe_text(provider.get("base_url")))
    )


def _topology_query(title: str, summary: str, nodes: List[Dict[str, Any]]) -> str:
    high_level_names = [
        _safe_text(node.get("node_name"))
        for node in nodes
        if isinstance(node, dict)
        and int(node.get("semantic_level") or node.get("level") or 0) >= 3
    ]
    parts = [part for part in (title, summary, *high_level_names[:8]) if _safe_text(part)]
    return " | ".join(map(_safe_text, parts)) or "Unlabelled conversation argument graph"


def _topology_marker(edges: List[Dict[str, Any]], *, status: str, reason: str = "") -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    for edge in edges:
        relation = _safe_text(edge.get("relation_type")).lower() or "contextual"
        counts[relation] = counts.get(relation, 0) + 1
    marker: Dict[str, Any] = {
        "version": ARGUMENT_TOPOLOGY_SCAN_VERSION,
        "status": status,
        "semantic_edge_count": len(edges),
        "relation_type_counts": counts,
    }
    if reason:
        marker["reason"] = reason
    return marker


def _merge_semantic_edges(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    by_id = {_safe_text(node.get("id")): node for node in nodes if isinstance(node, dict)}
    for edge in edges:
        source_id = _safe_text(edge.get("from_node_id"))
        target_id = _safe_text(edge.get("to_node_id"))
        relation = _safe_text(edge.get("relation_type")).lower()
        source = by_id.get(source_id)
        target = by_id.get(target_id)
        if source is None or target is None or not relation:
            continue
        explanation = _safe_text(edge.get("explanation"))
        source_name = _safe_text(source.get("node_name"))
        if not source_name:
            continue
        # graph_persistence's legacy authoring path interprets edge_relations
        # as INCOMING: related_node -> current node. Attach to the target so
        # evidence-b supports claim-a remains evidence-b -> claim-a.
        edge_relations = target.setdefault("edge_relations", [])
        relation_key = (source_name, relation)
        if not any(
            isinstance(existing, dict)
            and (_safe_text(existing.get("related_node")), _safe_text(existing.get("relation_type")).lower()) == relation_key
            for existing in edge_relations
        ):
            edge_relations.append({
                "related_node": source_name,
                "relation_type": relation,
                "relation_text": explanation or relation,
            })


@dataclass
class ImportResult:
    """Outcome of a successful parse-validate-persist cycle."""
    conversation_id: str
    utterance_count: int
    participant_count: int
    participants: list = field(default_factory=list)
    duration: Optional[float] = None
    validation: object = None  # ValidationResult from parser
    transcript: object = None  # ParsedTranscript from parser


# ---------------------------------------------------------------------------
# Building blocks (used individually by preview endpoint)
# ---------------------------------------------------------------------------

def parse_transcript(source, *, is_file: bool = False):
    """Parse a transcript from a file path or raw text.

    Returns ``(parser, transcript)`` so the caller can also call
    ``parser.validate_transcript(transcript)`` if needed.

    Raises ``ValueError`` on parse failure.
    """
    parser = GoogleMeetParser()
    if is_file:
        transcript = parser.parse_file(str(source))
    else:
        transcript = parser.parse_text(source)
    return parser, transcript


def validate_or_raise(parser, transcript):
    """Validate a parsed transcript; raise ``ValueError`` if invalid.

    Returns the ``ValidationResult`` on success.
    """
    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise ValueError(
            f"Transcript validation failed: {', '.join(validation.errors)}"
        )
    return validation


# ---------------------------------------------------------------------------
# Full orchestration
# ---------------------------------------------------------------------------

async def parse_validate_and_persist(
    db: AsyncSession,
    source,
    *,
    is_file: bool = False,
    source_type: str,
    conversation_name: str,
    owner_id: str = "anonymous",
    metadata: Optional[dict] = None,
) -> ImportResult:
    """Parse, validate, and persist a transcript in one call.

    Parameters
    ----------
    db : AsyncSession
        Database session for persistence.
    source : str | Path
        Raw text content *or* a file path (when ``is_file=True``).
    is_file : bool
        If ``True``, treat *source* as a file path.
    source_type : str
        One of ``"google_meet"``, ``"url"``, ``"text"``.
    conversation_name : str
        Human-readable name for the conversation.
    owner_id : str
        Creator / owner identifier.
    metadata : dict, optional
        Extra metadata to store alongside the conversation.

    Returns
    -------
    ImportResult
        A summary of the successfully imported transcript.

    Raises
    ------
    ValueError
        If parsing or validation fails (caller should map to HTTP 400).
    """
    parser, transcript = parse_transcript(source, is_file=is_file)

    validation = validate_or_raise(parser, transcript)

    conversation_id = str(uuid.uuid4())

    enriched_metadata = dict(metadata or {})
    enriched_metadata.setdefault("validation", {
        "warnings": validation.warnings,
        "stats": validation.stats,
    })

    if db is not None:
        await persist_transcript(
            db=db,
            transcript=transcript,
            conversation_id=conversation_id,
            conversation_name=conversation_name,
            source_type=source_type,
            owner_id=owner_id,
            metadata=enriched_metadata,
        )
        logger.info("Persisted conversation %s (%s utterances)", conversation_id, len(transcript.utterances))

    return ImportResult(
        conversation_id=conversation_id,
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
        participants=transcript.participants,
        duration=transcript.duration,
        validation=validation,
        transcript=transcript,
    )


async def extract_graph_for_conversation(
    db,
    *,
    conversation_id: Optional[str] = None,
    group_id: Optional[str] = None,
    owner_id: str = "anonymous",
) -> Dict[str, Any]:
    """Structured RawTurn import — Phase 2: the AUDITABLE extraction pass.

    Builds the drillable graph from turns ALREADY persisted by ``persist_turns``
    (``POST /api/import/turns``). Each persisted ``Utterance`` is fed to
    ``TranscriptProcessor.handle_final_text(..., utterance_id=<existing id>)`` so
    emitted nodes carry ``utterance_ids`` at build time (100% node↔utterance
    linkage — no post-hoc text-matching) and ``node.source_ref`` is real.

    Re-runnable by design (Eternal Reprocessability): ``persist_graph`` clears the
    conversation's prior nodes/relationships and re-materializes them while LEAVING
    the persisted ``Utterance`` rows untouched (``utterances=None``) — so you can
    re-extract (e.g. with a better model) without IndrasNet re-sending the turns.

    Resolve order: explicit ``conversation_id`` wins; else look the conversation up
    by ``(owner_id, indrasnet_group_id=group_id)``. Runs synchronously (one
    conversation's worth of turns). Returns a stats dict.
    """
    from sqlalchemy import select as _select

    from lct_python_backend.services.llm_config import load_llm_config, load_llm_providers
    from lct_python_backend.services.edge_enrichment import run_edge_enrichment
    from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor
    from lct_python_backend.services.graph_persistence import persist_graph
    from lct_python_backend.services.hierarchy_consolidator import (
        consolidate_ideas_to_topics,
        consolidate_topics_to_themes,
        consolidate_themes_to_arcs,
    )
    from lct_python_backend.services.tuning_constants import (
        MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
        MIN_TOPICS_FOR_THEME_CONSOLIDATION,
        MIN_THEMES_FOR_ARC_CONSOLIDATION,
    )
    from lct_python_backend.services.owner_context import resolve_owner_id
    from lct_python_backend.models import Conversation as _Conversation, Utterance as _Utterance

    # 1. Resolve the conversation Phase 1 (persist_turns) already created. Explicit
    #    conversation_id wins; else look up by (owner, indrasnet_group_id).
    if not conversation_id and not group_id:
        raise ValueError("extract requires either conversation_id or group_id")
    owner = resolve_owner_id(owner_id)
    conv = None
    if conversation_id:
        try:
            conv_uuid = uuid.UUID(str(conversation_id))
        except (ValueError, AttributeError, TypeError):
            raise ValueError("conversation_id must be a UUID")
        conv = (await db.execute(
            _select(_Conversation).where(_Conversation.id == conv_uuid)
        )).scalar_one_or_none()
    if conv is None and group_id:
        conv = (await db.execute(
            _select(_Conversation).where(
                _Conversation.owner_id == owner,
                _Conversation.indrasnet_group_id == group_id,
                _Conversation.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    if conv is None:
        raise ValueError(
            "no persisted conversation to extract — POST the turns to "
            f"/api/import/turns first (conversation_id={conversation_id!r}, "
            f"group_id={group_id!r})"
        )
    if conv.owner_id != owner:
        raise ValueError("conversation does not belong to this owner")
    if conv.deleted_at is not None:
        raise ValueError("conversation is deleted")
    conversation_id = str(conv.id)

    # 2. Load the persisted turns. Their EXISTING ids are the linkage anchors the
    #    extractor threads onto node.utterance_ids — NOT freshly minted.
    rows = (await db.execute(
        _select(_Utterance)
        .where(_Utterance.conversation_id == conv.id)
        .order_by(_Utterance.sequence_number)
    )).scalars().all()
    if not rows:
        raise ValueError(
            f"conversation {conversation_id} has no persisted turns to extract"
        )
    utterances: List[Dict[str, Any]] = [
        {
            "id": str(u.id),
            "text": u.text,
            "speaker_id": u.speaker_id or "SPEAKER_00",
            "sequence_number": u.sequence_number,
            "timestamp_start": u.timestamp_start,
            "timestamp_end": u.timestamp_end,
            "source_identifier": u.source_identifier,
            "platform_metadata": u.platform_metadata or {},
        }
        for u in rows
    ]
    logger.info(
        "[turns/extract] loaded %d persisted turns for conversation %s",
        len(utterances), conversation_id,
    )

    # 2. Configured LLM backend (server-side import → no BYOK session override).
    llm_config = await load_llm_config(db)
    providers_cfg = await load_llm_providers(db, include_secrets=True)
    providers = providers_cfg.get("providers") if isinstance(providers_cfg, dict) else []
    local_providers = [provider for provider in providers if _is_local_provider(provider)]

    async def _noop(*_a, **_k):
        return None

    processor = TranscriptProcessor(
        send_update=_noop, send_status=None,
        llm_config=llm_config, providers=providers or [],
    )

    # 3. Extract — feed each persisted turn with its EXISTING utterance_id so the
    #    emitted nodes get utterance_ids + chunk_utterance_map (transcript_processing.py).
    for utt in utterances:
        await processor.handle_final_text(
            utt["text"],
            speaker_segments=[{"speaker": utt["speaker_id"], "text": utt["text"]}],
            utterance_id=utt["id"],
        )
    await processor.flush()
    existing = list(processor.existing_json)

    # 4. Build the tier hierarchy (ideas→topics→themes→arcs), mirroring the live
    #    + bulk post-flush consolidation so the map is drillable. A consolidation
    #    LLM hiccup must NOT lose the import — the L1 nodes are the auditable core
    #    and higher tiers are enhancement, so failures here are caught + logged.
    summary = ""
    conversation_title = ""
    tiers_built: List[str] = []

    def _of_level(nodes, lvl):
        return [n for n in nodes if isinstance(n, dict) and int(n.get("semantic_level") or n.get("level") or 0) == lvl]

    try:
        ideas = _of_level(existing, 2)
        if len(ideas) >= MIN_IDEAS_FOR_TOPIC_CONSOLIDATION:
            topics = await consolidate_ideas_to_topics(ideas, providers=providers or [])
            if topics:
                existing.extend(topics)
                tiers_built.append("topics")
                if len(topics) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
                    themes = await consolidate_topics_to_themes(topics, providers=providers or [])
                    if themes:
                        existing.extend(themes)
                        tiers_built.append("themes")
                        if len(themes) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
                            arcs, title, s = await consolidate_themes_to_arcs(themes, providers=providers or [])
                            if arcs:
                                existing.extend(arcs)
                                tiers_built.append("arcs")
                                summary = s or summary
                                # The title was BOUND AND DISCARDED here (as
                                # `_title`) since the tier was written, so no
                                # export could ever carry a conversation title
                                # no matter what the model returned — and it
                                # does return one (verified in a live run
                                # 2026-08-12: "Redefining Success: AI Research,
                                # Security, and Collaboration"). conversations_
                                # api reads source_metadata["conversation_title"],
                                # so it only ever needed threading through.
                                conversation_title = title or conversation_title
    except Exception as exc:  # noqa: BLE001 — consolidation is best-effort
        logger.warning(
            "[turns/extract] consolidation failed after tiers=%s; persisting L1 graph anyway: %r",
            tiers_built, exc,
        )

    # 5. Scan the completed hierarchy for argumentative topology. Owner-local
    # imports never retrieve second-brain context and never use remote providers.
    argument_topology = _topology_marker([], status="failed", reason="not_run")
    try:
        semantic_edges, enrichment_telemetry = await run_edge_enrichment(
            nodes=existing,
            query_summary=_topology_query(
                conversation_title or conv.conversation_name or "",
                summary or "",
                existing,
            ),
            llm_config=llm_config,
            providers=local_providers,
            skip_context_lookup=True,
        )
        llm_telemetry = enrichment_telemetry.get("llm_telemetry") or {}
        scan_error = _safe_text(llm_telemetry.get("error"))
        parse_status = _safe_text(llm_telemetry.get("parse_status"))
        if scan_error or parse_status != "valid":
            argument_topology = _topology_marker(
                [], status="failed", reason=scan_error or "invalid_edge_payload"
            )
        else:
            _merge_semantic_edges(existing, semantic_edges)
            # A valid empty edge list is a legitimate completed scan. This is
            # distinct from a missing, truncated, or unparsable model answer.
            argument_topology = _topology_marker(semantic_edges, status="complete")
    except Exception as exc:  # noqa: BLE001 - marker makes failure explicit to callers
        logger.exception(
            "[turns/extract] argument-topology scan failed for conversation=%s",
            conversation_id,
        )
        argument_topology = _topology_marker(
            [], status="failed", reason=f"scan_error: {type(exc).__name__}: {exc}"
        )

    source_metadata = dict(conv.source_metadata or {}) if isinstance(conv.source_metadata, dict) else {}
    source_metadata.update({
        key: value for key, value in (
            ("executive_summary", summary),
            ("conversation_title", conversation_title),
            ("argument_topology", argument_topology),
        ) if value not in (None, "")
    })

    # 6. Persist the GRAPH only. utterances=None → persist_graph rewrites
    #    nodes/relationships and links to the already-persisted Utterance rows
    #    (it queries them for node timestamps) WITHOUT deleting/re-inserting them.
    node_count = await persist_graph(
        db=db,
        conversation_id=conversation_id,
        existing_json=existing,
        utterances=None,
        conversation_name=conv.conversation_name,
        source_type=conv.source_type,
        owner_id=owner,
        utterance_chunk_map=processor.chunk_utterance_map,
        indrasnet_group_id=conv.indrasnet_group_id,
        # Build from whatever the arcs pass produced: the old
        # `{"executive_summary": summary} if summary else {}` dropped a
        # perfectly good TITLE whenever the summary happened to be empty.
        source_metadata=source_metadata,
    )

    auditable_nodes = sum(1 for n in existing if n.get("utterance_ids"))
    return {
        "conversation_id": conversation_id,
        "utterance_count": len(utterances),
        "node_count": node_count,
        "auditable_node_count": auditable_nodes,
        "indrasnet_group_id": conv.indrasnet_group_id,
        "executive_summary": summary or None,
        "conversation_title": conversation_title or None,
        "argument_topology": argument_topology,
    }
