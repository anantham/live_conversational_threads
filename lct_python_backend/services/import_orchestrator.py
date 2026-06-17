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


async def parse_validate_and_extract(
    db,
    payload,
    *,
    owner_id: str = "anonymous",
) -> Dict[str, Any]:
    """Structured RawTurn import (P1 Track A): the AUDITABLE import path.

    Unlike ``parse_validate_and_persist`` (markdown → utterances only, no graph),
    this mints utterance UUIDs BEFORE extraction and threads each through
    ``TranscriptProcessor.handle_final_text(..., utterance_id=...)``, so the
    emitted nodes carry ``utterance_ids`` at build time (100% node↔utterance
    linkage — no post-hoc text-matching). It then persists with per-turn
    ``source_identifier`` + the conversation's ``indrasnet_group_id``, so
    ``node.source_ref`` and coverage are real from the first read.

    Runs synchronously (suitable for one conversation's worth of turns); a big
    backlog should be chunked by the caller. Returns a stats dict.

    ``payload`` is a ``models.import_contract.RawTurnPayload``.
    """
    import uuid as _uuid

    from lct_python_backend.services.llm_config import load_llm_config, load_llm_providers
    from lct_python_backend.services.transcript_processing import TranscriptProcessor
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

    conversation_id = payload.conversation_id or str(_uuid.uuid4())

    # Create-only guard. persist_graph is destructive (it DELETEs the
    # conversation's nodes before re-inserting), so a re-used conversation_id
    # would silently wipe the prior graph, and a repeated group_id would
    # duplicate the IndrasNet conversation. Refuse both up front — before any LLM
    # cost. Structured re-import/replace is a future feature (needs an explicit flag).
    from sqlalchemy import select as _select

    from lct_python_backend.models import Conversation as _Conversation

    if payload.conversation_id:
        if (await db.execute(
            _select(_Conversation.id).where(_Conversation.id == _uuid.UUID(payload.conversation_id))
        )).first():
            raise ValueError(
                f"conversation_id {payload.conversation_id} already exists; "
                "structured re-import is not yet supported"
            )
    if payload.group_id:
        dup = (await db.execute(
            _select(_Conversation.id).where(_Conversation.indrasnet_group_id == payload.group_id)
        )).first()
        if dup:
            raise ValueError(
                f"a conversation for group_id {payload.group_id} already exists ({dup[0]}); "
                "structured re-import is not yet supported"
            )

    # 1. Mint utterance UUIDs up front — the source of truth for IDs that the
    #    extractor will carry onto node.utterance_ids.
    utterances: List[Dict[str, Any]] = []
    for turn in payload.turns:
        utterances.append({
            "id": str(_uuid.uuid4()),
            "text": turn.text,
            "speaker_id": turn.speaker_id or "SPEAKER_00",
            "sequence_number": turn.seq,
            "timestamp_start": turn.ts_start,
            "timestamp_end": turn.ts_end,
            "source_identifier": turn.source_identifier,
            "platform_metadata": ({"contact_id": turn.contact_id} if turn.contact_id else {}),
        })
    logger.info(
        "[from-turns] minted %d utterances for %d turns (conversation %s)",
        len(utterances), len(payload.turns), conversation_id,
    )

    # 2. Configured LLM backend (server-side import → no BYOK session override).
    llm_config = await load_llm_config(db)
    providers_cfg = await load_llm_providers(db, include_secrets=True)
    providers = providers_cfg.get("providers") if isinstance(providers_cfg, dict) else []

    async def _noop(*_a, **_k):
        return None

    processor = TranscriptProcessor(
        send_update=_noop, send_status=None,
        llm_config=llm_config, providers=providers or [],
    )

    # 3. Extract — feed each turn with its minted utterance_id so the emitted
    #    nodes get utterance_ids + chunk_utterance_map (transcript_processing.py).
    for turn, utt in zip(payload.turns, utterances):
        await processor.handle_final_text(
            turn.text,
            speaker_segments=[{"speaker": utt["speaker_id"], "text": turn.text}],
            utterance_id=utt["id"],
        )
    await processor.flush()
    existing = list(processor.existing_json)

    # 4. Build the tier hierarchy (ideas→topics→themes→arcs), mirroring the live
    #    + bulk post-flush consolidation so the map is drillable. A consolidation
    #    LLM hiccup must NOT lose the import — the L1 nodes are the auditable core
    #    and higher tiers are enhancement, so failures here are caught + logged.
    summary = ""
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
                            arcs, _title, s = await consolidate_themes_to_arcs(themes, providers=providers or [])
                            if arcs:
                                existing.extend(arcs)
                                tiers_built.append("arcs")
                                summary = s or summary
    except Exception as exc:  # noqa: BLE001 — consolidation is best-effort
        logger.warning(
            "[from-turns] consolidation failed after tiers=%s; persisting L1 graph anyway: %r",
            tiers_built, exc,
        )

    # 5. Persist with provenance: source_identifier per utterance,
    #    indrasnet_group_id on the conversation, utterance_chunk_map so
    #    node.utterance_ids resolve. persist_graph creates the Conversation.
    node_count = await persist_graph(
        db=db,
        conversation_id=conversation_id,
        existing_json=existing,
        utterances=utterances,
        conversation_name=payload.conversation_name or f"{payload.source_type} import",
        source_type=payload.source_type,
        owner_id=owner_id,
        utterance_chunk_map=processor.chunk_utterance_map,
        indrasnet_group_id=payload.group_id,
        source_metadata=({"executive_summary": summary} if summary else {}),
    )

    auditable_nodes = sum(1 for n in existing if n.get("utterance_ids"))
    return {
        "conversation_id": conversation_id,
        "utterance_count": len(utterances),
        "node_count": node_count,
        "auditable_node_count": auditable_nodes,
        "indrasnet_group_id": payload.group_id,
        "executive_summary": summary or None,
    }
