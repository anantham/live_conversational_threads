"""The ``RawTurn[]`` v1 data contract (IndrasNet → LCT, one conversation).

Canonical serializer for the structured-turns ingest defined in
docs/plans/2026-06-17-p1-rawturn-data-contract.md (codex-reviewed, verdict GO).
Kept standalone (not buried in the router) so the IndrasNet side can mirror/import
the exact shape rather than guess it.

Privacy note (doc §4): ``redaction_applied`` is an UNVERIFIED upstream claim — a
boolean can't prove the text is pseudonymized. LCT trusts it; the real guarantee
(content-bound stamp + leak-verify) is ADR-038's job. The only redaction rule the
contract enforces is the ``owner_local_raw`` gate below (and the server
additionally requires ``LCT_MIRROR_RAW=1`` to honor it).
"""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

CONTRACT_VERSION = "1"


class RawTurnPrivacyV1(BaseModel):
    """Per-conversation privacy block (most-restrictive across participants)."""

    external_llm_ok: bool = False  # gates frontier calls; opt-in, default deny
    local_llm_ok: bool = True
    redaction_applied: bool = True  # TRUE = `text` is already pseudonymized
    redaction_map_id: Optional[str] = None  # which REDACTION_MAP (restore-on-display)


class RawTurnV1(BaseModel):
    """One verbatim turn → one ``Utterance`` row."""

    seq: int = Field(..., ge=0)  # 0-based dense → Utterance.sequence_number
    source_identifier: str = Field(..., min_length=1)  # stable per-turn id; NEVER null
    speaker_id: str
    contact_id: Optional[str] = None  # IndrasNet identity → platform_metadata.contact_id
    text: str  # verbatim at the privacy tier (never truncated/summarized)
    ts_start: Optional[float] = None
    ts_end: Optional[float] = None


class RawTurnsPayloadV1(BaseModel):
    """The ingest payload for ``POST /api/import/turns``."""

    contract_version: Literal["1"] = CONTRACT_VERSION
    group_id: str = Field(..., min_length=1)  # → Conversation.indrasnet_group_id
    conversation_id: Optional[str] = None  # set on re-ingest of a known group_id
    conversation_name: str
    source_type: str
    owner_id: str
    privacy: RawTurnPrivacyV1 = Field(default_factory=RawTurnPrivacyV1)
    # Request-level opt-in to store RAW (un-redacted) text. The server ALSO requires
    # LCT_MIRROR_RAW=1; this flag alone is not sufficient (doc §4.4 / §6.4).
    owner_local_raw: bool = False
    turns: List[RawTurnV1] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _check_invariants(self) -> "RawTurnsPayloadV1":
        n = len(self.turns)
        # seq must be dense 0..n-1 (unambiguous ordering + coverage math)
        if sorted(t.seq for t in self.turns) != list(range(n)):
            raise ValueError(
                f"turns.seq must be a dense 0..{n - 1} range with no gaps/dupes"
            )
        # source_identifier unique within the payload (it's the provenance key)
        srcids = [t.source_identifier for t in self.turns]
        if len(set(srcids)) != n:
            raise ValueError("turns.source_identifier must be unique within the payload")
        # redacted-by-default: raw text requires an explicit owner_local_raw opt-in
        if not self.privacy.redaction_applied and not self.owner_local_raw:
            raise ValueError(
                "redaction_applied=false requires owner_local_raw=true "
                "(the LCT mirror is redacted by default)"
            )
        return self
