"""Pure logic for the subject-side privacy review surface (ADR-039 P2a).

Everything here is DB- and network-free so the security-critical behavior is
unit-testable in isolation: the strict wire contract (``SubjectReviewBundleV1``),
the decisions payload, the structurally-safe GET response model, the
exact-set-equality + ``redact_span``-substring validation, the immutable
``decision_hash``, the browser-safe item subset, and the allowlisted relay-result
parser. The thin HTTP/DB/relay shell lives in ``subject_review_api.py``.

Privacy invariants this module enforces (ADR-039 §1–§4, "Privacy invariants"):
  - ``extra="forbid"`` on every inbound model: a producer ``reason`` /
    ``conversation_label`` / ``callback_url`` / ``redacted_context`` is REJECTED
    (the leak class ADR-055 closed by dropping model-generated free-text).
  - The GET response model structurally cannot carry ``callback_token`` /
    ``prayer_id`` / ``run_id`` / ``reason`` (a canary test asserts its field set).
  - ``redact_span`` must be a non-empty substring of that item's own
    ``proposed_redaction`` — a relayed span can only ever be the subject's own
    already-shown text.
  - Decisions must cover the stored items EXACTLY (every item decided once, no
    missing / extra / duplicate) — never partial-accept.
  - The relay-result parser keeps ONLY allowlisted scalars — never a raw
    upstream body.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------

CONTRACT_VERSION = "1"
MAX_NAME_LEN = 120
MAX_ITEM_TEXT_LEN = 20_000
MAX_SPAN_LEN = 20_000
MAX_ITEMS = 1_000
# The prayer_id column is Postgres INTEGER (signed 32-bit). Bounding it here
# (not just > 0) keeps an out-of-range value from passing validation and then
# failing at INSERT, where SQLAlchemy's default error would embed the bound
# params (callback_token + item text) in the exception string.
PG_INT4_MAX = 2_147_483_647

VALID_ACTIONS = ("confirm", "redact_more", "reject")


# ---------------------------------------------------------------------------
# Inbound wire contract: SubjectReviewBundleV1 (IndrasNet -> LCT import)
# ---------------------------------------------------------------------------


class SubjectReviewItemV1(BaseModel):
    """One redaction hunk the subject reviews — their OWN words + the AI's
    leak-verified redaction of their own line. No producer free-text."""

    model_config = ConfigDict(extra="forbid")

    position_in_doc: int
    original_text: str = Field(min_length=1, max_length=MAX_ITEM_TEXT_LEN)
    proposed_redaction: str = Field(min_length=1, max_length=MAX_ITEM_TEXT_LEN)


class SubjectReviewBundleV1(BaseModel):
    """The structured import contract that REPLACES the P1 markdown blob.

    Strict (``extra="forbid"``): any unknown field — notably a producer
    ``reason`` / ``conversation_label`` / ``callback_url`` / ``redacted_context``
    — fails validation (422) rather than being silently carried to the subject.
    """

    model_config = ConfigDict(extra="forbid")

    contract_version: str
    prayer_id: int
    run_id: str = Field(min_length=1, max_length=200)
    callback_token: str = Field(min_length=1, max_length=4_000)
    subject_email: str = Field(min_length=1, max_length=320)
    # No max_length here: the validator truncates a long display name to
    # MAX_NAME_LEN rather than rejecting a legitimately long one.
    subject_name: Optional[str] = Field(default=None)
    items: List[SubjectReviewItemV1]

    @field_validator("contract_version")
    @classmethod
    def _exact_version(cls, v: str) -> str:
        if v != CONTRACT_VERSION:
            raise ValueError(f"contract_version must be exactly {CONTRACT_VERSION!r}")
        return v

    @field_validator("prayer_id")
    @classmethod
    def _bounded_prayer_id(cls, v: int) -> int:
        if v <= 0 or v > PG_INT4_MAX:
            raise ValueError("prayer_id must be a positive 32-bit integer")
        return v

    @field_validator("subject_email")
    @classmethod
    def _normalize_email(cls, v: str) -> str:
        email = (v or "").strip().lower()
        if not email or "@" not in email:
            raise ValueError("subject_email must be a non-empty email address")
        return email

    @field_validator("subject_name")
    @classmethod
    def _cap_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        # Display-only; truncate rather than reject a legitimately long name.
        return v.strip()[:MAX_NAME_LEN] or None

    @field_validator("items")
    @classmethod
    def _items_valid(cls, v: List[SubjectReviewItemV1]) -> List[SubjectReviewItemV1]:
        if not v:
            raise ValueError("items must be a non-empty list")
        if len(v) > MAX_ITEMS:
            raise ValueError(f"items exceeds the cap of {MAX_ITEMS}")
        positions = [it.position_in_doc for it in v]
        if len(positions) != len(set(positions)):
            raise ValueError("position_in_doc must be unique across items")
        return v


# ---------------------------------------------------------------------------
# Decisions payload (subject's browser -> LCT)
# ---------------------------------------------------------------------------


class SubjectDecisionV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_in_doc: int
    action: str
    redact_span: Optional[str] = Field(default=None, max_length=MAX_SPAN_LEN)

    @field_validator("action")
    @classmethod
    def _known_action(cls, v: str) -> str:
        if v not in VALID_ACTIONS:
            raise ValueError(f"action must be one of {VALID_ACTIONS}")
        return v


class SubjectDecisionsPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisions: List[SubjectDecisionV1] = Field(min_length=1)


# ---------------------------------------------------------------------------
# GET response model — structurally cannot carry secrets/ids/free-text.
# (Canary test asserts the exact field set.)
# ---------------------------------------------------------------------------


class SubjectReviewItemView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_in_doc: int
    original_text: str
    proposed_redaction: str


class SubjectReviewView(BaseModel):
    """The ONLY shape returned to the subject's browser. There is deliberately
    no field for ``callback_token`` / ``prayer_id`` / ``run_id`` / ``reason`` /
    ``conversation_label`` — they cannot leak through this response."""

    model_config = ConfigDict(extra="forbid")

    subject_name: Optional[str]
    items: List[SubjectReviewItemView]
    status: str
    viewer_email: str


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def build_safe_items(bundle: SubjectReviewBundleV1) -> List[Dict[str, Any]]:
    """Explicitly copy ONLY the browser-returnable fields from each validated
    item — never ``model_dump()`` of the whole payload (which would carry the
    token/ids). No producer free-text is ever included."""
    return [
        {
            "position_in_doc": it.position_in_doc,
            "original_text": it.original_text,
            "proposed_redaction": it.proposed_redaction,
        }
        for it in bundle.items
    ]


class DecisionValidationError(ValueError):
    """Raised when a decisions payload does not exactly cover the stored items
    or carries an out-of-bounds ``redact_span``. Maps to HTTP 422."""


def validate_decisions_against_items(
    decisions: List[SubjectDecisionV1],
    items: List[Dict[str, Any]],
) -> None:
    """Fail-closed: the submitted positions MUST equal the stored item positions
    EXACTLY (every item decided once — no missing, no extra, no duplicate), and a
    ``redact_span`` may appear ONLY on ``redact_more`` and MUST be a non-empty
    substring of that item's ``proposed_redaction``. Raises DecisionValidationError
    on any violation — never partial-accept."""
    item_positions = {int(it["position_in_doc"]) for it in items}
    proposed_by_pos = {int(it["position_in_doc"]): str(it["proposed_redaction"]) for it in items}

    submitted = [d.position_in_doc for d in decisions]
    if len(submitted) != len(set(submitted)):
        raise DecisionValidationError("duplicate position_in_doc in decisions")
    if set(submitted) != item_positions:
        raise DecisionValidationError(
            "decisions must cover every reviewed item exactly once "
            "(no missing, no extra positions)"
        )

    for d in decisions:
        if d.action == "redact_more":
            span = d.redact_span or ""
            if not span:
                raise DecisionValidationError(
                    f"redact_more at position {d.position_in_doc} requires a non-empty redact_span"
                )
            if len(span) > MAX_SPAN_LEN:
                raise DecisionValidationError("redact_span exceeds the length cap")
            if span not in proposed_by_pos[d.position_in_doc]:
                raise DecisionValidationError(
                    f"redact_span at position {d.position_in_doc} is not a substring "
                    "of that item's proposed redaction"
                )
        else:
            # confirm / reject carry no span.
            if d.redact_span is not None:
                raise DecisionValidationError(
                    f"redact_span is only valid on redact_more (position {d.position_in_doc})"
                )


def canonical_decisions(decisions: List[SubjectDecisionV1]) -> str:
    """Order-independent canonical JSON of the decisions, so the hash binds to
    the decision SET regardless of submit order."""
    norm = sorted(
        (
            {
                "position_in_doc": d.position_in_doc,
                "action": d.action,
                "redact_span": d.redact_span,
            }
            for d in decisions
        ),
        key=lambda x: x["position_in_doc"],
    )
    return json.dumps(norm, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def compute_decision_hash(decisions: List[SubjectDecisionV1]) -> str:
    return hashlib.sha256(canonical_decisions(decisions).encode("utf-8")).hexdigest()


def decisions_for_relay(decisions: List[SubjectDecisionV1]) -> List[Dict[str, Any]]:
    """The minimal decision payload relayed to IndrasNet — only
    ``{position_in_doc, action, redact_span?}`` (span omitted unless present).
    LCT performs NO redaction logic; IndrasNet is the authority and
    re-leak-verifies."""
    out: List[Dict[str, Any]] = []
    for d in decisions:
        item: Dict[str, Any] = {"position_in_doc": d.position_in_doc, "action": d.action}
        if d.action == "redact_more" and d.redact_span:
            item["redact_span"] = d.redact_span
        out.append(item)
    return out


def parse_relay_result(body: Any) -> Dict[str, Any]:
    """Keep ONLY allowlisted scalar fields from IndrasNet's response — never the
    raw upstream body. A misbehaving upstream cannot smuggle content into our
    stored/returned ``relay_result`` through this filter."""
    out: Dict[str, Any] = {}
    if not isinstance(body, dict):
        return out
    substate = body.get("prayer_substate")
    if isinstance(substate, str):
        out["prayer_substate"] = substate[:64]
    additions = body.get("additions_applied")
    if isinstance(additions, int) and not isinstance(additions, bool):
        out["additions_applied"] = additions
    return out
