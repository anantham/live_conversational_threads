"""Tests for the leak-safe redaction module (codex-found bugs must stay fixed)."""

import pytest

from lct_python_backend.services.synthesis.redaction import (
    assert_clean,
    default_redaction_map,
    leaks,
    redact,
    restore,
)


class TestRedactCaseInsensitive:
    def test_redacts_all_cases(self):
        # The codex-found bug: the old re.sub had no IGNORECASE → lowercase leaked.
        out = redact("Vatsal and vatsal and VATSAL talked to Bhishma")
        assert "Vatsal" not in out
        assert "vatsal" not in out.lower().replace("[friend a]", "")
        assert "[Friend A]" in out
        assert "[Friend C]" in out

    def test_longest_name_first(self):
        out = redact("Vatsal Mehra spoke")
        assert out == "[Friend A] spoke"  # not "[Friend A] Mehra"

    def test_scrubs_email_and_handle(self):
        out = redact("reach me at foo.bar@example.com or @some_handle")
        assert "@example.com" not in out
        assert "[email]" in out
        assert "[handle]" in out

    def test_name_bearing_handle_scrubbed_whole(self):
        # codex finding #6: scrub handles BEFORE names so no "_mehra" fragment leaks.
        out = redact("ping @vatsal_mehra later")
        assert "vatsal" not in out.lower()
        assert "mehra" not in out.lower()
        assert "[handle]" in out
        assert leaks(out) == {}


class TestLeakScan:
    def test_leak_scan_is_case_insensitive(self):
        # The OTHER codex-found bug: \\b...\\b without IGNORECASE wouldn't even
        # CATCH a lowercase leak. It must now catch every case.
        assert leaks("vatsal was here")
        assert leaks("VATSAL was here")
        assert leaks("Bhishma too")

    def test_clean_text_has_no_leaks(self):
        assert leaks("[Friend A] and [Friend C] talked") == {}

    def test_assert_clean_raises_on_leak(self):
        with pytest.raises(PermissionError):
            assert_clean("vatsal slipped through")

    def test_assert_clean_passes_when_clean(self):
        assert_clean("[Friend A] is fine")  # no raise


class TestRestore:
    def test_restores_bracketed(self):
        assert restore("[Friend A] said hi") == "Vatsal said hi"

    def test_restores_bracketless(self):
        # Models drop brackets in prose.
        assert restore("Friend A said hi") == "Vatsal said hi"

    def test_round_trip_redact_then_restore(self):
        original = "Vatsal told Bhishma a secret"
        red = redact(original)
        assert leaks(red) == {}  # safe to send externally
        back = restore(red)
        assert "Vatsal" in back
        assert "Bhishma" in back


class TestRedactionMap:
    def test_default_map_has_forbidden_and_reverse(self):
        rmap = default_redaction_map()
        assert rmap.forbidden  # non-empty
        assert "[Friend A]" in rmap.reverse
        assert "Friend A" in rmap.reverse  # bracketless variant present
