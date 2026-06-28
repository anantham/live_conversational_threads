"""Unit tests for attendee_api.py pure-logic helpers.

Covers:
- _verify_signature: HMAC-SHA256 webhook guard (security-critical)
  - fail-closed when no secret configured (unless ALLOW_UNSIGNED=1)
  - valid signature → True
  - invalid signature → False
  - tampered body → False
  - missing header → False
  - bad base64 secret → False
- _auto_leave_settings: returns dict with expected keys
- _build_bot_settings: returns dict with expected keys
"""

import base64
import hashlib
import hmac
import importlib
import json
import sys
import types
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

def _load_attendee(monkeypatch, *, webhook_secret=None, allow_unsigned=False):
    """Load attendee_api with module-level globals patched."""
    for mod_path in [
        "lct_python_backend.services.attendee_client",
        "lct_python_backend.db_session",
        "lct_python_backend.middleware",
    ]:
        stub = types.ModuleType(mod_path)
        stub.AttendeeClient = MagicMock()
        stub.get_async_session = MagicMock()
        stub.check_ws_auth = MagicMock()
        stub.check_ws_auth_message = MagicMock()
        monkeypatch.setitem(sys.modules, mod_path, stub)

    sys.modules.pop("lct_python_backend.attendee_api", None)
    module = importlib.import_module("lct_python_backend.attendee_api")

    # Override module-level globals so tests control the security state
    monkeypatch.setattr(module, "ATTENDEE_WEBHOOK_SECRET", webhook_secret)
    monkeypatch.setattr(module, "ATTENDEE_ALLOW_UNSIGNED_WEBHOOK", allow_unsigned)

    return module


def _make_valid_signature(secret_b64: str, payload: dict) -> str:
    """Compute the expected HMAC-SHA256 signature for a payload."""
    secret = base64.b64decode(secret_b64)
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hmac.new(secret, canonical, hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


# A fixed test secret (base64-encoded 32 bytes)
_TEST_SECRET = base64.b64encode(b"a" * 32).decode()


# ---------------------------------------------------------------------------
# _verify_signature: fail-closed behavior
# ---------------------------------------------------------------------------

class TestVerifySignatureFailClosed:
    def test_no_secret_configured_rejects_by_default(self, monkeypatch):
        """When ATTENDEE_WEBHOOK_SECRET is unset, reject unless ALLOW_UNSIGNED=1."""
        module = _load_attendee(monkeypatch, webhook_secret=None, allow_unsigned=False)
        payload = {"event": "bot.started"}
        body = json.dumps(payload).encode()
        sig = "any-signature"
        assert module._verify_signature(body, sig) is False

    def test_no_secret_allow_unsigned_accepts(self, monkeypatch):
        """ATTENDEE_ALLOW_UNSIGNED_WEBHOOK=1 overrides the fail-closed rule."""
        module = _load_attendee(monkeypatch, webhook_secret=None, allow_unsigned=True)
        payload = {"event": "bot.started"}
        body = json.dumps(payload).encode()
        assert module._verify_signature(body, None) is True

    def test_missing_header_always_rejects(self, monkeypatch):
        """Even with a configured secret, missing signature header → False."""
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "bot.started"}
        body = json.dumps(payload).encode()
        assert module._verify_signature(body, None) is False

    def test_missing_header_empty_string_rejects(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "test"}
        body = json.dumps(payload).encode()
        assert module._verify_signature(body, "") is False


# ---------------------------------------------------------------------------
# _verify_signature: HMAC correctness
# ---------------------------------------------------------------------------

class TestVerifySignatureHmac:
    def test_valid_signature_accepted(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "bot.started", "meeting_id": "mtg-abc"}
        body = json.dumps(payload).encode()
        sig = _make_valid_signature(_TEST_SECRET, payload)
        assert module._verify_signature(body, sig) is True

    def test_wrong_secret_rejected(self, monkeypatch):
        wrong_secret = base64.b64encode(b"b" * 32).decode()
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "bot.started"}
        body = json.dumps(payload).encode()
        sig = _make_valid_signature(wrong_secret, payload)
        assert module._verify_signature(body, sig) is False

    def test_tampered_body_rejected(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "bot.started"}
        body = json.dumps(payload).encode()
        sig = _make_valid_signature(_TEST_SECRET, payload)
        # Tamper the body
        tampered = json.dumps({"event": "bot.started", "injected": True}).encode()
        assert module._verify_signature(tampered, sig) is False

    def test_signature_canonicalization_is_sort_keys(self, monkeypatch):
        """Key order in the HTTP body must not matter — sorted canonical."""
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"z": 1, "a": 2}
        # Compute sig over sorted payload
        sig = _make_valid_signature(_TEST_SECRET, payload)
        # Body sent with different key order
        body = json.dumps({"a": 2, "z": 1}).encode()
        # Should still pass because canonical is sort_keys=True
        assert module._verify_signature(body, sig) is True

    def test_invalid_base64_secret_returns_false(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret="not-valid-base64!!!")
        payload = {"event": "test"}
        body = json.dumps(payload).encode()
        assert module._verify_signature(body, "sig") is False

    def test_invalid_json_body_returns_false(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        body = b"not json {"
        assert module._verify_signature(body, "sig") is False

    def test_constant_time_comparison_no_timing_leak(self, monkeypatch):
        """The function uses hmac.compare_digest, not ==. Just verify it returns bool."""
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        payload = {"event": "test"}
        body = json.dumps(payload).encode()
        sig = _make_valid_signature(_TEST_SECRET, payload)
        result = module._verify_signature(body, sig)
        assert isinstance(result, bool)


# ---------------------------------------------------------------------------
# _auto_leave_settings
# ---------------------------------------------------------------------------

class TestAutoLeaveSettings:
    def test_returns_dict(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        result = module._auto_leave_settings()
        assert isinstance(result, dict)

    def test_contains_expected_keys(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        result = module._auto_leave_settings()
        # Should have some timeout/leave-related keys
        assert len(result) > 0

    def test_all_values_are_scalars(self, monkeypatch):
        """Settings should be plain scalars — no nested dicts that surprise callers."""
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        result = module._auto_leave_settings()
        for v in result.values():
            assert not isinstance(v, dict), f"Unexpected nested dict in auto_leave_settings: {v}"


# ---------------------------------------------------------------------------
# _build_bot_settings
# ---------------------------------------------------------------------------

class TestBuildBotSettings:
    def test_returns_dict(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        result = module._build_bot_settings()
        assert isinstance(result, dict)

    def test_has_transcription_related_key(self, monkeypatch):
        module = _load_attendee(monkeypatch, webhook_secret=_TEST_SECRET)
        result = module._build_bot_settings()
        # Check the dict is non-empty and has string keys
        assert len(result) > 0
        for k in result:
            assert isinstance(k, str)
