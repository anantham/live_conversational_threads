"""Intent Signal review API (ADR-013).

This slice exposes owner-scoped review data and the first human-gated lifecycle
actions. Formalization, merging, and lull-resume behavior remain separate.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status
from pydantic import BaseModel, Field
from sqlalchemy import desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation, IntentSignal, IntentSignalSighting
from lct_python_backend.services.owner_context import get_current_owner_id

logger = logging.getLogger(__name__)
router = APIRouter(tags=["intent-signals"])

DEFAULT_REVIEW_STATUSES = ("active", "accumulating", "ready")
VALID_STATUSES = {
    "active",
    "accumulating",
    "ready",
    "formalized",
    "abandoned",
}


class IntentSignalSightingResponse(BaseModel):
    id: str
    conversation_id: str
    utterance_ids: List[str] = Field(default_factory=list)
    context_note: Optional[str] = None
    sighting_confidence: Optional[float] = None
    sighted_at: Optional[datetime] = None


class IntentSignalResponse(BaseModel):
    id: str
    conversation_id: str
    raw_text: str
    context_window: str
    speaker_id: str
    source_utterance_ids: List[str] = Field(default_factory=list)
    source_node_id: Optional[str] = None
    status: str
    emerged_at: Optional[datetime] = None
    sighting_count: int
    last_sighted_at: Optional[datetime] = None
    last_sighted_conversation_id: Optional[str] = None
    detection_confidence: Optional[float] = None
    detection_model: Optional[str] = None
    candidate_formal_statement: Optional[str] = None
    formalization_offered_at: Optional[datetime] = None
    human_reviewed: bool = False
    human_review_note: Optional[str] = None
    formalized_claim_id: Optional[str] = None
    formalized_node_id: Optional[str] = None
    salience: Optional[float] = None
    tags: List[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    sightings: List[IntentSignalSightingResponse] = Field(default_factory=list)


class IntentSignalListResponse(BaseModel):
    conversation_id: str
    count: int
    items: List[IntentSignalResponse]


class IntentSignalLifecycleUpdateRequest(BaseModel):
    status: Literal["ready", "abandoned"]
    human_review_note: Optional[str] = Field(default=None, max_length=2000)


class IntentSignalsConversationNotFound(Exception):
    """Conversation missing, deleted, or not owned by current requester."""


class IntentSignalsSignalNotFound(Exception):
    """Intent signal missing or not visible from the requested conversation."""


class IntentSignalsLifecycleConflict(Exception):
    """Requested lifecycle transition would rewrite a terminal signal."""


async def _load_owned_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Conversation:
    owner_id = get_current_owner_id()
    conversation_result = await db.execute(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.owner_id == owner_id,
            Conversation.deleted_at.is_(None),
        )
    )
    conversation = conversation_result.scalar_one_or_none()
    if conversation is None:
        raise IntentSignalsConversationNotFound()
    return conversation


def _owned_conversation_ids_query(owner_id: str):
    return select(Conversation.id).where(
        Conversation.owner_id == owner_id,
        Conversation.deleted_at.is_(None),
    )


def _parse_status_filter(value: Optional[str]) -> Optional[List[str]]:
    if value is None or not value.strip():
        return list(DEFAULT_REVIEW_STATUSES)
    raw = value.strip().lower()
    if raw == "all":
        return None
    statuses = [item.strip().lower() for item in raw.split(",") if item.strip()]
    bad = [item for item in statuses if item not in VALID_STATUSES]
    if bad:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown intent signal status: {', '.join(bad)}",
        )
    return statuses or list(DEFAULT_REVIEW_STATUSES)


def _uuid_list(values) -> List[str]:
    if not values:
        return []
    return [str(value) for value in values if value]


def serialize_intent_signal_sighting(sighting: IntentSignalSighting) -> IntentSignalSightingResponse:
    return IntentSignalSightingResponse(
        id=str(sighting.id),
        conversation_id=str(sighting.conversation_id),
        utterance_ids=_uuid_list(sighting.utterance_ids),
        context_note=sighting.context_note,
        sighting_confidence=sighting.sighting_confidence,
        sighted_at=sighting.sighted_at,
    )


def serialize_intent_signal(
    signal: IntentSignal,
    *,
    sightings: Optional[List[IntentSignalSighting]] = None,
) -> IntentSignalResponse:
    return IntentSignalResponse(
        id=str(signal.id),
        conversation_id=str(signal.conversation_id),
        raw_text=signal.raw_text,
        context_window=signal.context_window,
        speaker_id=signal.speaker_id,
        source_utterance_ids=_uuid_list(signal.source_utterance_ids),
        source_node_id=str(signal.source_node_id) if signal.source_node_id else None,
        status=signal.status,
        emerged_at=signal.emerged_at,
        sighting_count=signal.sighting_count or 0,
        last_sighted_at=signal.last_sighted_at,
        last_sighted_conversation_id=(
            str(signal.last_sighted_conversation_id)
            if signal.last_sighted_conversation_id
            else None
        ),
        detection_confidence=signal.detection_confidence,
        detection_model=signal.detection_model,
        candidate_formal_statement=signal.candidate_formal_statement,
        formalization_offered_at=signal.formalization_offered_at,
        human_reviewed=bool(signal.human_reviewed),
        human_review_note=signal.human_review_note,
        formalized_claim_id=str(signal.formalized_claim_id) if signal.formalized_claim_id else None,
        formalized_node_id=str(signal.formalized_node_id) if signal.formalized_node_id else None,
        salience=signal.salience,
        tags=list(signal.tags or []),
        created_at=signal.created_at,
        updated_at=signal.updated_at,
        sightings=[
            serialize_intent_signal_sighting(sighting)
            for sighting in (sightings or [])
        ],
    )


async def list_intent_signals_for_conversation(
    *,
    db: AsyncSession,
    conversation_id: uuid.UUID,
    statuses: Optional[List[str]],
    limit: int,
) -> IntentSignalListResponse:
    conversation = await _load_owned_conversation(db, conversation_id)
    owner_id = conversation.owner_id
    owned_conversation_ids = _owned_conversation_ids_query(owner_id)

    sighted_signal_ids = select(IntentSignalSighting.intent_signal_id).where(
        IntentSignalSighting.conversation_id == conversation_id
    )
    query = (
        select(IntentSignal)
        .where(
            IntentSignal.conversation_id.in_(owned_conversation_ids),
            or_(
                IntentSignal.conversation_id == conversation_id,
                IntentSignal.id.in_(sighted_signal_ids),
            )
        )
        .order_by(
            desc(IntentSignal.salience),
            desc(IntentSignal.last_sighted_at),
            desc(IntentSignal.emerged_at),
        )
        .limit(limit)
    )
    if statuses is not None:
        query = query.where(IntentSignal.status.in_(statuses))

    result = await db.execute(query)
    signals = list(result.scalars().all())
    if not signals:
        return IntentSignalListResponse(conversation_id=str(conversation_id), count=0, items=[])

    signal_ids = [signal.id for signal in signals]
    sightings_result = await db.execute(
        select(IntentSignalSighting)
        .where(
            IntentSignalSighting.intent_signal_id.in_(signal_ids),
            IntentSignalSighting.conversation_id.in_(owned_conversation_ids),
        )
        .order_by(desc(IntentSignalSighting.sighted_at))
    )
    grouped: Dict[uuid.UUID, List[IntentSignalSighting]] = defaultdict(list)
    for sighting in sightings_result.scalars().all():
        grouped[sighting.intent_signal_id].append(sighting)

    items = [
        serialize_intent_signal(signal, sightings=grouped.get(signal.id, []))
        for signal in signals
    ]
    return IntentSignalListResponse(
        conversation_id=str(conversation_id),
        count=len(items),
        items=items,
    )


async def update_intent_signal_lifecycle(
    *,
    db: AsyncSession,
    conversation_id: uuid.UUID,
    signal_id: uuid.UUID,
    status: Literal["ready", "abandoned"],
    human_review_note: Optional[str] = None,
    note_provided: bool = False,
) -> IntentSignalResponse:
    conversation = await _load_owned_conversation(db, conversation_id)
    owner_id = conversation.owner_id
    owned_conversation_ids = _owned_conversation_ids_query(owner_id)
    sighted_signal_ids = select(IntentSignalSighting.intent_signal_id).where(
        IntentSignalSighting.conversation_id == conversation_id
    )

    signal_result = await db.execute(
        select(IntentSignal).where(
            IntentSignal.id == signal_id,
            IntentSignal.conversation_id.in_(owned_conversation_ids),
            or_(
                IntentSignal.conversation_id == conversation_id,
                IntentSignal.id.in_(sighted_signal_ids),
            ),
        )
    )
    signal = signal_result.scalar_one_or_none()
    if signal is None:
        raise IntentSignalsSignalNotFound()
    if signal.status == "formalized":
        raise IntentSignalsLifecycleConflict("Formalized intent signals cannot be reclassified.")

    now = datetime.now(timezone.utc)
    prior_status = signal.status
    signal.status = status
    signal.human_reviewed = True
    signal.updated_at = now
    if note_provided:
        cleaned_note = (human_review_note or "").strip()
        signal.human_review_note = cleaned_note or None

    await db.flush()
    sightings_result = await db.execute(
        select(IntentSignalSighting)
        .where(
            IntentSignalSighting.intent_signal_id == signal.id,
            IntentSignalSighting.conversation_id.in_(owned_conversation_ids),
        )
        .order_by(desc(IntentSignalSighting.sighted_at))
    )
    logger.info(
        "Intent signal %s lifecycle changed %s -> %s for conversation %s",
        signal.id,
        prior_status,
        status,
        conversation_id,
    )
    return serialize_intent_signal(
        signal,
        sightings=list(sightings_result.scalars().all()),
    )


@router.get(
    "/api/conversations/{conversation_id}/intent-signals",
    response_model=IntentSignalListResponse,
)
async def get_conversation_intent_signals(
    conversation_id: uuid.UUID,
    status: Optional[str] = Query(
        None,
        description="Comma-separated statuses, or 'all'. Defaults to active,accumulating,ready.",
    ),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_async_session),
):
    try:
        statuses = _parse_status_filter(status)
        return await list_intent_signals_for_conversation(
            db=db,
            conversation_id=conversation_id,
            statuses=statuses,
            limit=limit,
        )
    except HTTPException:
        raise
    except IntentSignalsConversationNotFound as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to list intent signals for conversation %s",
            conversation_id,
        )
        raise HTTPException(status_code=500, detail="Intent signal lookup failed") from exc


@router.patch(
    "/api/conversations/{conversation_id}/intent-signals/{signal_id}",
    response_model=IntentSignalResponse,
)
async def patch_conversation_intent_signal(
    conversation_id: uuid.UUID,
    signal_id: uuid.UUID,
    body: IntentSignalLifecycleUpdateRequest,
    db: AsyncSession = Depends(get_async_session),
):
    try:
        return await update_intent_signal_lifecycle(
            db=db,
            conversation_id=conversation_id,
            signal_id=signal_id,
            status=body.status,
            human_review_note=body.human_review_note,
            note_provided="human_review_note" in body.model_fields_set,
        )
    except IntentSignalsConversationNotFound as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc
    except IntentSignalsSignalNotFound as exc:
        raise HTTPException(status_code=404, detail="Intent signal not found") from exc
    except IntentSignalsLifecycleConflict as exc:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to update intent signal %s for conversation %s",
            signal_id,
            conversation_id,
        )
        raise HTTPException(status_code=500, detail="Intent signal update failed") from exc
