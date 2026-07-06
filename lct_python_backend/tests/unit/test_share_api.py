"""Unit tests for share_api pure helpers.

Scope: the helper functions in share_api.py that don't need a DB
session, FastAPI test client, or live Google certs. Covers:

  - Email allowlist normalization (lowercase + dedupe + sort + None-collapse)
  - Email JSON roundtrip
  - Audio URL HMAC sign + verify (constant-time, expiry-bound)
  - Audio URL minting (shape + expiry math)
  - Audio file resolution (path-traversal guard, suffix detection)
  - Google ID token verification (via google.oauth2 mock)

The 4 route handlers (POST /share, GET /shares, DELETE /share, GET
/share/{token}) need DB + TestClient and are out of scope here —
deferred to a future integration pass.
"""

from __future__ import annotations

# NOTE: db_session no longer needs stubbing — its engine is created lazily on
# first use, so importing share_api works without DATABASE_URL. The old
# sys.modules stub here leaked across the whole pytest collection and broke
# unrelated test files that needed names the stub lacked.

import json
import time
from unittest.mock import patch

import pytest

from lct_python_backend import share_api
from lct_python_backend.share_api import (
    _build_share_audio_url,
    _normalize_emails,
    _parse_emails,
    _resolve_audio_file,
    _sign_audio_url,
    _verify_audio_signature,
    _verify_google_id_token,
)


# ── _normalize_emails ────────────────────────────────────────────────────────


class TestNormalizeEmails:
    def test_none_returns_none(self):
        assert _normalize_emails(None) is None

    def test_empty_list_returns_none(self):
        assert _normalize_emails([]) is None

    def test_whitespace_only_strings_collapse_to_none(self):
        assert _normalize_emails(["", "   ", "\t"]) is None

    def test_lowercases(self):
        result = _normalize_emails(["Alice@Example.com"])
        assert json.loads(result) == ["alice@example.com"]

    def test_dedupes_case_insensitive(self):
        result = _normalize_emails(["a@b.com", "A@B.com", "a@b.com"])
        assert json.loads(result) == ["a@b.com"]

    def test_sorts_alphabetically(self):
        result = _normalize_emails(["c@x.com", "a@x.com", "b@x.com"])
        assert json.loads(result) == ["a@x.com", "b@x.com", "c@x.com"]

    def test_strips_internal_whitespace_in_entries(self):
        result = _normalize_emails(["  alice@example.com  "])
        assert json.loads(result) == ["alice@example.com"]

    def test_filters_none_and_empty_mixed_with_valid(self):
        result = _normalize_emails(["alice@example.com", "", None, "  "])
        assert json.loads(result) == ["alice@example.com"]


# ── _parse_emails ────────────────────────────────────────────────────────────


class TestParseEmails:
    def test_none_returns_none(self):
        assert _parse_emails(None) is None

    def test_empty_string_returns_none(self):
        assert _parse_emails("") is None

    def test_valid_json_list_roundtrips(self):
        raw = _normalize_emails(["a@b.com", "c@d.com"])
        assert _parse_emails(raw) == ["a@b.com", "c@d.com"]

    def test_malformed_json_returns_none(self):
        # Per implementation: log + return None on JSONDecodeError.
        assert _parse_emails("{not valid json") is None

    def test_non_list_json_returns_none(self):
        # {"foo": "bar"} is valid JSON but not a list; helper returns None.
        assert _parse_emails('{"foo": "bar"}') is None

    def test_coerces_non_string_list_entries_to_string(self):
        # Defensive: if somehow numbers slipped in, they're stringified.
        assert _parse_emails("[1, 2]") == ["1", "2"]


# ── _sign_audio_url + _verify_audio_signature ────────────────────────────────


class TestAudioUrlSigning:
    def test_sign_is_deterministic(self):
        s1 = _sign_audio_url("token-abc", 1234567890)
        s2 = _sign_audio_url("token-abc", 1234567890)
        assert s1 == s2

    def test_different_tokens_produce_different_signatures(self):
        assert _sign_audio_url("token-A", 100) != _sign_audio_url("token-B", 100)

    def test_different_expiries_produce_different_signatures(self):
        assert _sign_audio_url("token", 100) != _sign_audio_url("token", 200)

    def test_signature_is_base64url_no_padding(self):
        sig = _sign_audio_url("token", 100)
        # base64url uses A-Z a-z 0-9 - _ and no '=' padding per impl
        assert "=" not in sig
        assert "+" not in sig
        assert "/" not in sig

    def test_verify_accepts_correct_signature(self):
        sig = _sign_audio_url("tok-X", 1700000000)
        assert _verify_audio_signature("tok-X", 1700000000, sig) is True

    def test_verify_rejects_tampered_token(self):
        sig = _sign_audio_url("tok-X", 1700000000)
        assert _verify_audio_signature("tok-Y", 1700000000, sig) is False

    def test_verify_rejects_tampered_expiry(self):
        sig = _sign_audio_url("tok-X", 1700000000)
        assert _verify_audio_signature("tok-X", 1700000001, sig) is False

    def test_verify_rejects_mangled_signature(self):
        sig = _sign_audio_url("tok-X", 1700000000)
        bad = sig[:-1] + ("A" if sig[-1] != "A" else "B")
        assert _verify_audio_signature("tok-X", 1700000000, bad) is False

    def test_verify_rejects_empty_signature(self):
        assert _verify_audio_signature("tok-X", 1700000000, "") is False


# ── _build_share_audio_url ───────────────────────────────────────────────────


class TestBuildShareAudioUrl:
    def test_url_shape(self):
        url, expires = _build_share_audio_url("abc123")
        assert url.startswith("/api/share/abc123/audio?expires=")
        assert f"expires={expires}" in url
        assert "&sig=" in url

    def test_expiry_is_ttl_seconds_in_future(self):
        before = int(time.time())
        _, expires = _build_share_audio_url("tok")
        after = int(time.time())
        # expires should be approximately TTL seconds after "now"
        ttl = share_api.SHARE_AUDIO_SIGNATURE_TTL_SECONDS
        assert before + ttl <= expires <= after + ttl

    def test_minted_url_verifies(self):
        url, expires = _build_share_audio_url("tok")
        # Extract sig from the query string
        sig = url.split("&sig=")[1]
        assert _verify_audio_signature("tok", expires, sig) is True


# ── _resolve_audio_file ──────────────────────────────────────────────────────


class TestResolveAudioFile:
    def test_returns_none_when_no_file_exists(self, tmp_path, monkeypatch):
        monkeypatch.setattr(share_api, "AUDIO_RECORDINGS_DIR", str(tmp_path))
        assert _resolve_audio_file("nonexistent-conv-id") is None

    def test_resolves_wav(self, tmp_path, monkeypatch):
        monkeypatch.setattr(share_api, "AUDIO_RECORDINGS_DIR", str(tmp_path))
        (tmp_path / "conv-1.wav").write_bytes(b"fake-audio")
        result = _resolve_audio_file("conv-1")
        assert result is not None
        path, media_type = result
        assert path.name == "conv-1.wav"
        assert media_type == "audio/wav"

    def test_resolves_m4a(self, tmp_path, monkeypatch):
        monkeypatch.setattr(share_api, "AUDIO_RECORDINGS_DIR", str(tmp_path))
        (tmp_path / "conv-2.m4a").write_bytes(b"fake")
        result = _resolve_audio_file("conv-2")
        assert result is not None
        assert result[1] == "audio/mp4"

    def test_rejects_path_traversal_attempt(self, tmp_path, monkeypatch):
        # Create a file OUTSIDE the recordings root that a "../" path
        # could otherwise reach.
        outside = tmp_path.parent / "elsewhere.wav"
        outside.write_bytes(b"fake")
        monkeypatch.setattr(share_api, "AUDIO_RECORDINGS_DIR", str(tmp_path))
        # The conversation_id contains "..", so the joined path resolves
        # outside the recordings root and the guard should kick in.
        result = _resolve_audio_file("../elsewhere")
        assert result is None
        # Cleanup
        outside.unlink(missing_ok=True)


# ── _verify_google_id_token ──────────────────────────────────────────────────


class TestVerifyGoogleIdToken:
    @pytest.mark.asyncio
    async def test_503_when_client_id_not_configured(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", None)
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            await _verify_google_id_token("any-token")
        assert exc.value.status_code == 503

    @pytest.mark.asyncio
    async def test_401_on_value_error_from_verify(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")

        class _FakeIdToken:
            @staticmethod
            def verify_oauth2_token(*a, **k):
                raise ValueError("bad signature")

        class _FakeRequests:
            class Request:
                pass

        with patch.dict(
            "sys.modules",
            {
                "google.oauth2.id_token": _FakeIdToken,
                "google.auth.transport.requests": _FakeRequests,
            },
        ):
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc:
                await _verify_google_id_token("bad-token")
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_500_on_unexpected_exception(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")

        class _FakeIdToken:
            @staticmethod
            def verify_oauth2_token(*a, **k):
                raise RuntimeError("network blew up")

        class _FakeRequests:
            class Request:
                pass

        with patch.dict(
            "sys.modules",
            {
                "google.oauth2.id_token": _FakeIdToken,
                "google.auth.transport.requests": _FakeRequests,
            },
        ):
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc:
                await _verify_google_id_token("token")
        assert exc.value.status_code == 500

    @pytest.mark.asyncio
    async def test_401_when_no_email_claim(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")

        class _FakeIdToken:
            @staticmethod
            def verify_oauth2_token(*a, **k):
                return {"sub": "12345"}  # No email

        class _FakeRequests:
            class Request:
                pass

        with patch.dict(
            "sys.modules",
            {
                "google.oauth2.id_token": _FakeIdToken,
                "google.auth.transport.requests": _FakeRequests,
            },
        ):
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc:
                await _verify_google_id_token("token")
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_403_when_email_not_verified(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")

        class _FakeIdToken:
            @staticmethod
            def verify_oauth2_token(*a, **k):
                return {"email": "user@example.com", "email_verified": False}

        class _FakeRequests:
            class Request:
                pass

        with patch.dict(
            "sys.modules",
            {
                "google.oauth2.id_token": _FakeIdToken,
                "google.auth.transport.requests": _FakeRequests,
            },
        ):
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc:
                await _verify_google_id_token("token")
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_returns_lowercased_email_on_success(self, monkeypatch):
        monkeypatch.setattr(share_api, "GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")

        class _FakeIdToken:
            @staticmethod
            def verify_oauth2_token(*a, **k):
                return {"email": "  Alice@Example.COM  ", "email_verified": True}

        class _FakeRequests:
            class Request:
                pass

        with patch.dict(
            "sys.modules",
            {
                "google.oauth2.id_token": _FakeIdToken,
                "google.auth.transport.requests": _FakeRequests,
            },
        ):
            email = await _verify_google_id_token("token")
        assert email == "alice@example.com"


# ── Cross-helper: end-to-end sign + serialize + verify ───────────────────────


class TestEndToEnd:
    def test_full_audio_url_lifecycle(self):
        """Mint → extract from URL → verify → use to construct expected URL."""
        url, expires = _build_share_audio_url("conv-99")
        # Parse query string by hand to avoid pulling urlparse in
        assert "/api/share/conv-99/audio?" in url
        qs = url.split("?", 1)[1]
        params = dict(p.split("=") for p in qs.split("&"))
        assert int(params["expires"]) == expires
        sig = params["sig"]
        assert _verify_audio_signature("conv-99", expires, sig) is True
        # Tampering with token in the URL should fail verification
        assert _verify_audio_signature("conv-OTHER", expires, sig) is False

    def test_normalize_then_parse_roundtrip(self):
        raw = _normalize_emails(["Bob@Example.com", "alice@example.com", "bob@example.com"])
        parsed = _parse_emails(raw)
        assert parsed == ["alice@example.com", "bob@example.com"]
