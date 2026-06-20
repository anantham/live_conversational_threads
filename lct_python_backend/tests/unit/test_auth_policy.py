"""Tests for auth_policy path classification and bearer checks."""

from lct_python_backend import auth_policy as auth


def test_requires_admin_auth_for_prayer_detect():
    assert auth.requires_admin_auth("/api/conversations/conv-1/prayer-detect", "POST") is True


def test_requires_admin_auth_allows_public_import():
    assert auth.requires_admin_auth("/api/import/process-file", "POST") is False


def test_is_public_share_get_only():
    assert auth.is_public_share("/api/share/abc123", "GET") is True
    assert auth.is_public_share("/api/share/abc123", "DELETE") is False


def test_check_bearer_token_accepts_valid_token():
    assert auth.check_bearer_token("Bearer secret", token="secret") is True
    assert auth.check_bearer_token("Bearer wrong", token="secret") is False