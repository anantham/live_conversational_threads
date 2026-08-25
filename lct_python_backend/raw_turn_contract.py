"""The ``RawTurn[]`` v1 data contract (IndrasNet → LCT, one conversation).

Canonical serializer for the structured-turns ingest defined in
docs/plans/2026-06-17-p1-rawturn-data-contract.md (codex-reviewed). Kept
standalone (not buried in the router) so the IndrasNet side can mirror/import the
exact shape rather than guess it.

Privacy note (doc §4): ``redaction_applied`` is an UNVERIFIED upstream claim — a
boolean can't prove the text is pseudonymized. LCT trusts it; the real guarantee
(content-bound stamp + leak-verify) is ADR-038's job. The only redaction rule the
contract enforces is the ``owner_local_raw`` gate (and the server additionally
requires a ``personal_private`` deployment profile to honor it). The models are fail-closed:
``extra="forbid"`` (so a misspelled ``redactionApplied`` is rejected, not silently
ignored) and ``redaction_applied`` is REQUIRED (so omitting privacy can't default
un-redacted text to "safe").
"""

import uuid as _uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CONTRACT_VERSION = "1"


class RawTurnPrivacyV1(BaseModel):
    """Per-conversation privacy block (most-restrictive across participants)."""

    model_config = ConfigDict(extra="forbid")

    # Required (no default): the producer MUST state whether `text` is redacted —
    # defaulting it would silently treat un-redacted text as safe (codex #2).
    redaction_applied: bool
    external_llm_ok: bool = False  # gates frontier calls; opt-in, default deny
    local_llm_ok: bool = True
    redaction_map_id: Optional[str] = None  # which REDACTION_MAP (restore-on-display)


class RawTurnV1(BaseModel):
    """One verbatim turn → one ``Utterance`` row."""

    model_config = ConfigDict(extra="forbid")

    seq: int = Field(..., ge=0)  # 0-based dense → Utterance.sequence_number
    source_identifier: str = Field(..., min_length=1)  # stable per-turn id; NEVER null
    speaker_id: str
    contact_id: Optional[str] = None  # IndrasNet identity → platform_metadata.contact_id
    text: str  # verbatim at the privacy tier (never truncated/summarized)
    ts_start: Optional[float] = None
    ts_end: Optional[float] = None

class RawTurnMediaRefV1(BaseModel):
    """Content-free recording provenance; access remains provider-controlled."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["google_drive"]
    kind: Literal["video"] = "video"
    file_id: str = Field(..., min_length=8, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")
    view_url: str = Field(..., max_length=500)
    label: str = Field(default="Meeting recording", max_length=240)

    @model_validator(mode="after")
    def _url_matches_file_id(self) -> "RawTurnMediaRefV1":
        expected = f"https://drive.google.com/file/d/{self.file_id}/view"
        if self.view_url.rstrip("/") != expected:
            raise ValueError("media ref view_url must be the canonical Drive URL for file_id")
        self.view_url = expected
        return self


class RawTurnSourceMetadataV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    media_refs: List[RawTurnMediaRefV1] = Field(default_factory=list, max_length=4)



class RawTurnsPayloadV1(BaseModel):
    """The ingest payload for ``POST /api/import/turns``."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1"] = CONTRACT_VERSION
    group_id: str = Field(..., min_length=1)  # → Conversation.indrasnet_group_id
    conversation_id: Optional[str] = None  # set on re-ingest of a known group_id
    conversation_name: str
    source_type: str
    owner_id: str
    privacy: RawTurnPrivacyV1  # REQUIRED — no fail-open default (codex #2)
    # Request-level opt-in to store RAW (un-redacted) text. The server ALSO requires
    # a personal-private deployment; this flag alone is not sufficient.
    owner_local_raw: bool = False
    source_metadata: RawTurnSourceMetadataV1 = Field(default_factory=RawTurnSourceMetadataV1)
    turns: List[RawTurnV1] = Field(..., min_length=1)

    @field_validator("conversation_id")
    @classmethod
    def _conversation_id_is_uuid(cls, value: Optional[str]) -> Optional[str]:
        # Validate UUID shape here (→ 422) rather than letting uuid.UUID() blow up
        # in persistence (→ 400/500).
        if value is None:
            return value
        try:
            _uuid.UUID(str(value))
        except (ValueError, AttributeError, TypeError):
            raise ValueError("conversation_id must be a UUID")
        return value

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
        # timestamps, when present, must be ordered (the DB CHECK would otherwise
        # turn this into a 500 — codex #4)
        for t in self.turns:
            if t.ts_start is not None and t.ts_end is not None and t.ts_end < t.ts_start:
                raise ValueError(
                    f"turn seq={t.seq}: ts_end ({t.ts_end}) must be >= ts_start ({t.ts_start})"
                )
        # redacted-by-default: raw text requires an explicit owner_local_raw opt-in
        if not self.privacy.redaction_applied and not self.owner_local_raw:
            raise ValueError(
                "redaction_applied=false requires owner_local_raw=true "
                "(the LCT mirror is redacted by default)"
            )
        return self
