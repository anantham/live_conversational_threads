"""Structured RawTurn import contract (P1, LCT × IndrasNet).

Per docs/plans/2026-06-08-lct-indrasnet-pipeline.md §2: a versioned, per-turn
contract keyed by IndrasNet ``group_id``. Each ``RawTurn`` → one ``Utterance``
row; the durable provenance key is ``(sequence_number, source_identifier)``,
carried into ``node.source_ref``.

This is the LOSSLESS structured alternative to the markdown ``from-text`` import:
it preserves turn identity, ``source_identifier``, ``contact_id`` and timestamps,
so node↔utterance linkage is authored at extraction time (utterance UUIDs are
minted BEFORE extraction and threaded through ``TranscriptProcessor``) and every
node is auditable back to source — no post-hoc text-matching needed.
"""

from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


class PrivacyFlags(BaseModel):
    """Per-conversation privacy posture carried across the IndrasNet boundary.

    LCT honours these (e.g. ``external_llm_ok`` gates frontier-model calls); the
    canonical redaction map stays in IndrasNet (``redaction_map_id`` references it).
    """

    external_llm_ok: bool = False
    local_llm_ok: bool = True
    redaction_applied: bool = False
    redaction_map_id: Optional[str] = None


class RawTurn(BaseModel):
    """One conversation turn. Maps 1:1 to an ``Utterance`` row."""

    seq: int = Field(..., ge=0, description="Turn order; strictly increasing within a payload")
    source_identifier: str = Field(
        ..., min_length=1,
        description="Immutable per-turn provenance anchor (IndrasNet items.source_identifier)",
    )
    text: str = Field(..., min_length=1, description="Verbatim turn text — never truncated")
    speaker_id: Optional[str] = None
    contact_id: Optional[str] = None
    ts_start: Optional[float] = None
    ts_end: Optional[float] = None


class RawTurnPayload(BaseModel):
    """The structured import envelope. POST body for /api/import/from-turns."""

    group_id: Optional[str] = Field(
        None, description="IndrasNet stable conversation key → Conversation.indrasnet_group_id (enables re-pull)",
    )
    conversation_id: Optional[str] = Field(
        None, description="Optional explicit LCT conversation UUID (dedup/upsert by the caller)",
    )
    source_type: str = "indrasnet"
    contract_version: str = "1.0"
    conversation_name: Optional[str] = None
    owner_id: Optional[str] = None
    privacy: PrivacyFlags = Field(default_factory=PrivacyFlags)
    turns: List[RawTurn] = Field(..., min_length=1)

    @field_validator("turns")
    @classmethod
    def _validate_turns(cls, turns: List[RawTurn]) -> List[RawTurn]:
        seqs = [t.seq for t in turns]
        if seqs != sorted(seqs):
            raise ValueError("turns must be supplied in non-decreasing seq order")
        srcids = [t.source_identifier for t in turns]
        if len(set(srcids)) != len(srcids):
            raise ValueError("source_identifier must be unique within a payload")
        return turns
