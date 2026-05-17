"""Unit tests for the agenda-query phrase detector.

The detector runs on every finalized segment. Key properties to pin:
  - Never raises (None/empty input → clean no-match).
  - Case-insensitive substring match.
  - Custom env phrases beat defaults (so deployment overrides are visible).
  - False-positive resistance — distinct words like "agenda" alone don't fire.
"""

import pytest

from lct_python_backend.services import agenda_query_detector as aqd


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in ("AGENDA_QUERY_DETECTOR_ENABLED", "AGENDA_QUERY_PATTERNS"):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def test_disabled_by_default():
    assert aqd.is_enabled() is False


@pytest.mark.parametrize("val", ["true", "1", "yes", "on"])
def test_enabled_when_set(monkeypatch, val):
    monkeypatch.setenv("AGENDA_QUERY_DETECTOR_ENABLED", val)
    assert aqd.is_enabled() is True


def test_no_custom_phrases_by_default():
    assert aqd._load_custom_phrases() == []


def test_custom_phrases_parsed_from_env(monkeypatch):
    monkeypatch.setenv("AGENDA_QUERY_PATTERNS", "yo what's our list ; agenda fam ; spec list")
    phrases = aqd._load_custom_phrases()
    assert phrases == ["yo what's our list", "agenda fam", "spec list"]


def test_custom_phrases_come_first_in_active_list(monkeypatch):
    monkeypatch.setenv("AGENDA_QUERY_PATTERNS", "custom phrase one")
    active = aqd.get_active_phrases()
    assert active[0] == ("custom phrase one", "custom")
    assert any(s == "default" for _, s in active)


# ---------------------------------------------------------------------------
# Detector — positive matches
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("segment, expected_phrase", [
    ("I pray to see the agenda for this conversation", "i pray to see"),
    ("I wish I could see what was pending", "i wish i could see"),
    ("So, what was pending between us?", "what was pending"),
    ("Can you remind me what we wanted to discuss?", "remind me what we"),
    ("What did we want to talk about last time", "what did we want to talk about"),
    ("Show me the list please", "show me the list"),
    ("What's on our agenda today", "what's on our agenda"),
    ("Pending discussions for us right now", "pending discussions"),
])
def test_detects_positive_phrases(segment, expected_phrase):
    result = aqd.detect_agenda_query(segment)
    assert result.matched is True
    assert result.phrase == expected_phrase
    assert result.source == "default"


def test_match_is_case_insensitive():
    result = aqd.detect_agenda_query("I PRAY TO SEE the agenda for this conversation")
    assert result.matched is True


def test_match_finds_phrase_in_middle_of_segment():
    result = aqd.detect_agenda_query(
        "Hmm hey wait actually what was pending? sorry getting distracted"
    )
    assert result.matched is True
    assert result.phrase == "what was pending"


def test_returns_first_match_when_multiple_phrases_present():
    """Custom phrase first if env has one that matches."""
    import os
    os.environ["AGENDA_QUERY_PATTERNS"] = "what was pending"
    try:
        result = aqd.detect_agenda_query(
            "what was pending and what's on our agenda"
        )
        assert result.matched is True
        # Custom matches first
        assert result.source == "custom"
        assert result.phrase == "what was pending"
    finally:
        del os.environ["AGENDA_QUERY_PATTERNS"]


# ---------------------------------------------------------------------------
# Detector — negative cases (false-positive resistance)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("segment", [
    "we should talk about money and parents",  # new prayer, not query
    "let me check the agenda doc later",  # 'agenda' alone shouldn't fire
    "this is pending review by the board",  # 'pending' alone shouldn't fire
    "remind me to call Sahil tomorrow",  # different remind context
    "show me how to do this",  # 'show me' alone shouldn't fire
    "what was that thing called?",  # 'what was' alone shouldn't fire
    "the agenda item 3 is interesting",  # 'agenda' alone
    "list of things I need to buy",  # 'list' alone
    "I wish you could come to the meeting",  # 'I wish' alone
])
def test_no_false_positive(segment):
    result = aqd.detect_agenda_query(segment)
    assert result.matched is False, f"expected no match, got {result.phrase!r}"


# ---------------------------------------------------------------------------
# Detector — edge cases
# ---------------------------------------------------------------------------

def test_empty_segment_returns_no_match():
    assert aqd.detect_agenda_query("").matched is False


def test_none_segment_returns_no_match():
    assert aqd.detect_agenda_query(None).matched is False


def test_whitespace_only_returns_no_match():
    assert aqd.detect_agenda_query("   \n\t  ").matched is False


def test_result_to_dict():
    result = aqd.AgendaQueryResult(matched=True, phrase="what was pending", source="default")
    d = result.to_dict()
    assert d == {"matched": True, "phrase": "what was pending", "source": "default"}


def test_no_match_returns_empty_phrase():
    result = aqd.detect_agenda_query("we should buy groceries")
    assert result.matched is False
    assert result.phrase == ""
    assert result.source == ""


def test_custom_env_phrase_can_override_match(monkeypatch):
    """If user adds a personal phrase, it should fire even if not in defaults."""
    monkeypatch.setenv(
        "AGENDA_QUERY_PATTERNS",
        "what's our pending sit;agenda for the sit",
    )
    result = aqd.detect_agenda_query(
        "Hey what's our pending sit looking like for Sunday"
    )
    assert result.matched is True
    assert result.phrase == "what's our pending sit"
    assert result.source == "custom"


def test_does_not_raise_on_unicode():
    """Devanagari + accented input should not break the lowercase / substring path."""
    result = aqd.detect_agenda_query("चर्चा karna hai Bhīṣma ke saath what was pending hmm")
    assert result.matched is True  # contains "what was pending"


def test_handles_extremely_long_segment():
    """Long segments must still complete fast — substring is O(n*m)."""
    segment = "blah blah " * 5000 + "what was pending" + " blah blah" * 5000
    result = aqd.detect_agenda_query(segment)
    assert result.matched is True
