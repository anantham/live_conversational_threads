"""Tests for share-audio URL HMAC signing (share_api).

The report flagged share_api as zero-tested. These cover the security-critical,
DB-free part: the signed audio URL can't be replayed cross-token or past expiry,
and a tampered signature is rejected. (DB/Google-token flow tests are a follow-up.)
"""

import re
import time

import pytest


def _share():
    try:
        # importing share_api inits the DB engine; skip when DATABASE_URL isn't set
        from lct_python_backend import share_api
    except Exception:  # noqa: BLE001
        pytest.skip("share_api requires DATABASE_URL set")
    return share_api


def test_signature_round_trip():
    s = _share()
    tok, exp = "tok-abc", int(time.time()) + 600
    sig = s._sign_audio_url(tok, exp)
    assert s._verify_audio_signature(tok, exp, sig) is True


def test_cross_token_rejected():
    s = _share()
    exp = int(time.time()) + 600
    sig = s._sign_audio_url("tokA", exp)
    assert s._verify_audio_signature("tokB", exp, sig) is False


def test_expiry_tamper_rejected():
    s = _share()
    tok, exp = "tok", int(time.time()) + 600
    sig = s._sign_audio_url(tok, exp)
    assert s._verify_audio_signature(tok, exp + 1, sig) is False


def test_garbage_signature_rejected():
    s = _share()
    tok, exp = "tok", int(time.time()) + 600
    assert s._verify_audio_signature(tok, exp, "not-a-real-signature") is False


def test_build_share_audio_url_is_self_consistent():
    s = _share()
    url, expires = s._build_share_audio_url("tok-xyz")
    assert "/api/share/tok-xyz/audio" in url
    assert f"expires={expires}" in url and "sig=" in url
    assert expires > int(time.time())
    sig = re.search(r"sig=([^&]+)", url).group(1)
    assert s._verify_audio_signature("tok-xyz", expires, sig) is True
