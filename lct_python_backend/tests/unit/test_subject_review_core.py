"""Pure-logic tests for the subject-side privacy review (ADR-039 P2a).

No DB, no network — covers the strict wire contract, the decisions validation
(exact set equality + redact_span substring), the immutable decision hash, the
browser-safe item subset, the allowlisted relay-result parser, and the canary
that the GET response model structurally cannot carry secrets/ids/free-text.
"""
import pytest
from pydantic import ValidationError

from lct_python_backend.subject_review_core import (
    DecisionValidationError,
    SubjectDecisionsPayloadV1,
    SubjectDecisionV1,
    SubjectReviewBundleV1,
    SubjectReviewView,
    build_safe_items,
    canonical_decisions,
    compute_decision_hash,
    decisions_for_relay,
    parse_relay_result,
    validate_decisions_against_items,
)


def _bundle(**kw):
    base = dict(
        contract_version="1",
        prayer_id=1234,
        run_id="run-1",
        callback_token="cbk-secret",
        subject_email="Vatsal@Example.com",
        subject_name="Vatsal",
        items=[
            {"position_in_doc": 7, "original_text": "my own words", "proposed_redaction": "my [REDACTED] words"},
            {"position_in_doc": 9, "original_text": "second line", "proposed_redaction": "second [X]"},
        ],
    )
    base.update(kw)
    return base


# --------------------------------------------------------------------------
# Import contract: SubjectReviewBundleV1
# --------------------------------------------------------------------------


def test_valid_bundle_normalizes_email_lowercase():
    b = SubjectReviewBundleV1(**_bundle())
    assert b.subject_email == "vatsal@example.com"
    assert b.prayer_id == 1234
    assert len(b.items) == 2


def test_contract_version_must_be_exactly_1():
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(contract_version="2"))
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(contract_version="1.0"))


@pytest.mark.parametrize("leak_field", ["reason", "conversation_label", "callback_url", "redacted_context"])
def test_bundle_rejects_producer_freetext_fields(leak_field):
    """The canary: extra='forbid' rejects exactly the leak-class fields ADR-055 dropped."""
    bad = _bundle()
    bad[leak_field] = "owner or third-party text"
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**bad)


def test_item_rejects_extra_field():
    bad = _bundle()
    bad["items"][0]["reason"] = "model said so"
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**bad)


def test_empty_subject_email_rejected():
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(subject_email=""))
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(subject_email="not-an-email"))


def test_non_unique_positions_rejected():
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(items=[
            {"position_in_doc": 1, "original_text": "a", "proposed_redaction": "x"},
            {"position_in_doc": 1, "original_text": "b", "proposed_redaction": "y"},
        ]))


def test_empty_items_rejected():
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(items=[]))


def test_non_positive_prayer_id_rejected():
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(prayer_id=0))
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(prayer_id=-3))


def test_oversized_prayer_id_rejected():
    # > Postgres int4 max — would otherwise pass validation and fail at INSERT,
    # leaking the bound callback_token/items into the DB error (codex round-3).
    with pytest.raises(ValidationError):
        SubjectReviewBundleV1(**_bundle(prayer_id=2_147_483_648))
    # the boundary value is accepted
    assert SubjectReviewBundleV1(**_bundle(prayer_id=2_147_483_647)).prayer_id == 2_147_483_647


def test_subject_name_capped_to_120():
    b = SubjectReviewBundleV1(**_bundle(subject_name="N" * 500))
    assert len(b.subject_name) == 120


def test_build_safe_items_only_three_fields():
    b = SubjectReviewBundleV1(**_bundle())
    items = build_safe_items(b)
    for it in items:
        assert set(it.keys()) == {"position_in_doc", "original_text", "proposed_redaction"}
    # no callback_token / prayer_id / run_id leaks into the browser-returnable subset
    blob = str(items)
    assert "cbk-secret" not in blob
    assert "1234" not in blob


# --------------------------------------------------------------------------
# GET response model canary
# --------------------------------------------------------------------------


def test_view_model_cannot_carry_secrets():
    fields = set(SubjectReviewView.model_fields)
    assert fields == {"subject_name", "items", "status", "viewer_email"}
    for forbidden in ("callback_token", "prayer_id", "run_id", "reason", "conversation_label"):
        assert forbidden not in fields
    # extra='forbid' means a stray secret can't be injected either
    with pytest.raises(ValidationError):
        SubjectReviewView(subject_name="x", items=[], status="pending",
                          viewer_email="a@b.com", callback_token="leak")


# --------------------------------------------------------------------------
# Decisions payload
# --------------------------------------------------------------------------


def test_decisions_unknown_action_rejected():
    with pytest.raises(ValidationError):
        SubjectDecisionsPayloadV1(decisions=[{"position_in_doc": 1, "action": "delete_everything"}])


def test_decisions_empty_rejected():
    with pytest.raises(ValidationError):
        SubjectDecisionsPayloadV1(decisions=[])


def test_decision_extra_field_rejected():
    with pytest.raises(ValidationError):
        SubjectDecisionsPayloadV1(decisions=[
            {"position_in_doc": 1, "action": "confirm", "smuggled": "x"},
        ])


# --------------------------------------------------------------------------
# validate_decisions_against_items: exact set equality + redact_span
# --------------------------------------------------------------------------


_ITEMS = [
    {"position_in_doc": 7, "original_text": "my own words", "proposed_redaction": "my [REDACTED] words"},
    {"position_in_doc": 9, "original_text": "second line", "proposed_redaction": "second [X]"},
]


def _decisions(*specs):
    return [SubjectDecisionV1(**s) for s in specs]


def test_exact_set_equality_ok():
    validate_decisions_against_items(
        _decisions({"position_in_doc": 7, "action": "confirm"},
                   {"position_in_doc": 9, "action": "reject"}),
        _ITEMS,
    )


def test_missing_position_rejected():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "confirm"}), _ITEMS,
        )


def test_extra_position_rejected():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "confirm"},
                       {"position_in_doc": 9, "action": "confirm"},
                       {"position_in_doc": 11, "action": "confirm"}),
            _ITEMS,
        )


def test_duplicate_position_rejected():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "confirm"},
                       {"position_in_doc": 7, "action": "reject"},
                       {"position_in_doc": 9, "action": "confirm"}),
            _ITEMS,
        )


def test_redact_span_valid_substring_ok():
    validate_decisions_against_items(
        _decisions({"position_in_doc": 7, "action": "redact_more", "redact_span": "[REDACTED]"},
                   {"position_in_doc": 9, "action": "confirm"}),
        _ITEMS,
    )


def test_redact_span_non_substring_rejected():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "redact_more", "redact_span": "NOT IN THERE"},
                       {"position_in_doc": 9, "action": "confirm"}),
            _ITEMS,
        )


def test_redact_more_requires_span():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "redact_more"},
                       {"position_in_doc": 9, "action": "confirm"}),
            _ITEMS,
        )


def test_span_on_confirm_rejected():
    with pytest.raises(DecisionValidationError):
        validate_decisions_against_items(
            _decisions({"position_in_doc": 7, "action": "confirm", "redact_span": "my"},
                       {"position_in_doc": 9, "action": "confirm"}),
            _ITEMS,
        )


# --------------------------------------------------------------------------
# decision hash + relay payload + relay-result parsing
# --------------------------------------------------------------------------


def test_decision_hash_order_independent():
    a = _decisions({"position_in_doc": 7, "action": "confirm"},
                   {"position_in_doc": 9, "action": "reject"})
    b = _decisions({"position_in_doc": 9, "action": "reject"},
                   {"position_in_doc": 7, "action": "confirm"})
    assert compute_decision_hash(a) == compute_decision_hash(b)


def test_decision_hash_differs_on_different_set():
    a = _decisions({"position_in_doc": 7, "action": "confirm"},
                   {"position_in_doc": 9, "action": "reject"})
    b = _decisions({"position_in_doc": 7, "action": "reject"},
                   {"position_in_doc": 9, "action": "reject"})
    assert compute_decision_hash(a) != compute_decision_hash(b)


def test_decisions_for_relay_omits_span_unless_redact_more():
    out = decisions_for_relay(_decisions(
        {"position_in_doc": 7, "action": "confirm"},
        {"position_in_doc": 9, "action": "redact_more", "redact_span": "[X]"},
    ))
    assert out[0] == {"position_in_doc": 7, "action": "confirm"}
    assert out[1] == {"position_in_doc": 9, "action": "redact_more", "redact_span": "[X]"}


def test_parse_relay_result_allowlists_scalars_only():
    parsed = parse_relay_result({
        "prayer_substate": "AWAITING_OWNER_APPROVAL",
        "additions_applied": 3,
        "leaked_owner_text": "SECRET OWNER LINE",
        "raw_body": {"nested": "stuff"},
    })
    assert parsed == {"prayer_substate": "AWAITING_OWNER_APPROVAL", "additions_applied": 3}


def test_parse_relay_result_rejects_non_int_and_caps_substate():
    parsed = parse_relay_result({
        "prayer_substate": "Z" * 500,
        "additions_applied": True,  # bool is not a valid int count
    })
    assert len(parsed["prayer_substate"]) == 64
    assert "additions_applied" not in parsed


def test_parse_relay_result_non_dict_is_empty():
    assert parse_relay_result("a raw string body") == {}
    assert parse_relay_result(None) == {}


def test_canonical_decisions_is_stable_json():
    d = _decisions({"position_in_doc": 9, "action": "reject"},
                   {"position_in_doc": 7, "action": "confirm"})
    assert canonical_decisions(d) == (
        '[{"action":"confirm","position_in_doc":7,"redact_span":null},'
        '{"action":"reject","position_in_doc":9,"redact_span":null}]'
    )
