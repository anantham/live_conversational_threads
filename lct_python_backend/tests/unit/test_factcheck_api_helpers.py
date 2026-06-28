"""Unit tests for factcheck_api.py pure-logic helpers.

All functions tested here are side-effect-free and need no DB / network.

Covers:
- _slugify: safe filename slug generation
- _sanitize_conversation_name: slug + short-id format
- _format_duration_short: Hh Mm Ss / Mm Ss / Ss edge cases
- _build_audio_filename: full filename construction from conversation attrs
"""

import importlib
import sys
import types
from datetime import datetime
from typing import Optional
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel
from typing import List


# ---------------------------------------------------------------------------
# Minimal real Pydantic stubs — FastAPI inspects response_model at import time
# so MagicMock causes FastAPIError. Use real Pydantic models.
# ---------------------------------------------------------------------------

class _StubClaimsResponse(BaseModel):
    claims: list = []

class _StubFactCheckRequest(BaseModel):
    claims: List[str] = []

class _StubAPICallsLog(BaseModel):
    pass


# ---------------------------------------------------------------------------
# Module loader — stub heavy imports (perplexity, DB models, etc.)
# ---------------------------------------------------------------------------

def _load_factcheck(monkeypatch):
    stub_svc = types.ModuleType("lct_python_backend.services.factcheck_service")
    stub_svc.generate_fact_check_json_perplexity_service = MagicMock()
    monkeypatch.setitem(sys.modules, "lct_python_backend.services.factcheck_service", stub_svc)

    stub_cost = types.ModuleType("lct_python_backend.services.cost_tracking_service")
    stub_cost.aggregate_cost_logs = MagicMock(return_value={})
    monkeypatch.setitem(sys.modules, "lct_python_backend.services.cost_tracking_service", stub_cost)

    # schemas must have real Pydantic models — FastAPI validates response_model at import
    dummy_schemas = types.ModuleType("lct_python_backend.schemas")
    dummy_schemas.ClaimsResponse = _StubClaimsResponse
    dummy_schemas.FactCheckRequest = _StubFactCheckRequest
    dummy_schemas.APICallsLog = _StubAPICallsLog
    monkeypatch.setitem(sys.modules, "lct_python_backend.schemas", dummy_schemas)

    async def _dummy_session():
        yield object()

    dummy_db = types.ModuleType("lct_python_backend.db_session")
    dummy_db.get_async_session = _dummy_session
    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db)

    sys.modules.pop("lct_python_backend.factcheck_api", None)
    return importlib.import_module("lct_python_backend.factcheck_api")


# ---------------------------------------------------------------------------
# _slugify
# ---------------------------------------------------------------------------

class TestSlugify:
    def _fn(self, monkeypatch):
        return _load_factcheck(monkeypatch)._slugify

    def test_plain_text_becomes_underscored(self, monkeypatch):
        fn = self._fn(monkeypatch)
        assert fn("hello world") == "hello_world"

    def test_hyphens_converted(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("foo-bar baz")
        assert " " not in result
        assert "-" not in result

    def test_special_chars_stripped(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("hello! world? (test)")
        assert "!" not in result
        assert "?" not in result
        assert "(" not in result

    def test_max_len_respected(self, monkeypatch):
        fn = self._fn(monkeypatch)
        long_text = "a" * 100
        assert len(fn(long_text, max_len=20)) <= 20

    def test_default_max_len_50(self, monkeypatch):
        fn = self._fn(monkeypatch)
        long_text = "word " * 30
        assert len(fn(long_text)) <= 50

    def test_empty_string_returns_empty(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("")
        assert result == ""

    def test_unicode_normalized(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("café")
        # The café é may become e after NFKD normalization
        assert isinstance(result, str)
        assert len(result) > 0

    def test_no_leading_trailing_underscores(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("  hello world  ")
        assert not result.startswith("_")
        assert not result.endswith("_")


# ---------------------------------------------------------------------------
# _sanitize_conversation_name
# ---------------------------------------------------------------------------

class TestSanitizeConversationName:
    def _fn(self, monkeypatch):
        return _load_factcheck(monkeypatch)._sanitize_conversation_name

    def test_name_plus_short_id(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("Team Meeting", "abcdef1234567890")
        assert "Team_Meeting" in result
        assert "abcdef12" in result  # first 8 chars of id

    def test_none_name_falls_back_to_full_id(self, monkeypatch):
        fn = self._fn(monkeypatch)
        cid = "abc12345"
        result = fn(None, cid)
        assert result == cid

    def test_empty_name_falls_back_to_full_id(self, monkeypatch):
        fn = self._fn(monkeypatch)
        cid = "abc12345"
        result = fn("", cid)
        assert result == cid

    def test_whitespace_only_name_falls_back(self, monkeypatch):
        fn = self._fn(monkeypatch)
        cid = "abc12345"
        result = fn("   ", cid)
        assert result == cid

    def test_format_is_slug_then_id(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn("My Talk", "deadbeef12345678")
        # slug first, then (short-id) in parens
        assert result.startswith("My_Talk")
        assert "deadbeef" in result


# ---------------------------------------------------------------------------
# _format_duration_short
# ---------------------------------------------------------------------------

class TestFormatDurationShort:
    def _fn(self, monkeypatch):
        return _load_factcheck(monkeypatch)._format_duration_short

    def test_none_returns_empty(self, monkeypatch):
        assert self._fn(monkeypatch)(None) == ""

    def test_zero_returns_empty(self, monkeypatch):
        assert self._fn(monkeypatch)(0) == ""

    def test_negative_returns_empty(self, monkeypatch):
        assert self._fn(monkeypatch)(-10) == ""

    def test_seconds_only(self, monkeypatch):
        assert self._fn(monkeypatch)(45) == "45s"

    def test_minutes_and_seconds(self, monkeypatch):
        assert self._fn(monkeypatch)(90) == "1m30s"

    def test_exactly_one_minute(self, monkeypatch):
        assert self._fn(monkeypatch)(60) == "1m00s"

    def test_hours_minutes_seconds(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(3661)  # 1h 1m 1s
        assert result == "1h01m01s"

    def test_two_hours(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(7200)  # exactly 2h
        assert result == "2h00m00s"

    def test_float_seconds_rounded(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(90.6)
        assert result == "1m31s"


# ---------------------------------------------------------------------------
# _build_audio_filename
# ---------------------------------------------------------------------------

class TestBuildAudioFilename:
    def _fn(self, monkeypatch):
        return _load_factcheck(monkeypatch)._build_audio_filename

    def _conv(self, name="Team Meeting", started_at=None, duration=None, participant_count=0):
        conv = MagicMock()
        conv.conversation_name = name
        conv.started_at = started_at
        conv.duration_seconds = duration
        conv.participant_count = participant_count
        return conv

    def test_filename_ends_with_suffix(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(self._conv(), "abc12345678", ".wav")
        assert result.endswith(".wav")

    def test_suffix_without_dot_gets_dot_prepended(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(self._conv(), "abc12345678", "flac")
        assert result.endswith(".flac")

    def test_name_included_in_filename(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(self._conv(name="My_Meeting"), "abc12345678", ".wav")
        assert "My_Meeting" in result

    def test_date_included_when_started_at_set(self, monkeypatch):
        fn = self._fn(monkeypatch)
        dt = datetime(2026, 6, 29, 10, 0, 0)
        conv = self._conv(started_at=dt)
        result = fn(conv, "abc12345678", ".wav")
        assert "2026-06-29" in result

    def test_no_date_when_started_at_none(self, monkeypatch):
        fn = self._fn(monkeypatch)
        result = fn(self._conv(started_at=None), "abc12345678", ".wav")
        assert "2026" not in result

    def test_duration_included_when_set(self, monkeypatch):
        fn = self._fn(monkeypatch)
        conv = self._conv(duration=90)
        result = fn(conv, "abc12345678", ".wav")
        assert "1m30s" in result

    def test_participant_count_included_when_positive(self, monkeypatch):
        fn = self._fn(monkeypatch)
        conv = self._conv(participant_count=3)
        result = fn(conv, "abc12345678", ".wav")
        assert "3 spk" in result

    def test_no_participant_count_when_zero(self, monkeypatch):
        fn = self._fn(monkeypatch)
        conv = self._conv(participant_count=0)
        result = fn(conv, "abc12345678", ".wav")
        assert "spk" not in result
