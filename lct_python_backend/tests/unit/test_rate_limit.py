"""Tests for rate_limit tier selection."""

from lct_python_backend.rate_limit import is_expensive_path, resolve_rate_limit_tier


def test_is_expensive_path_matches_theme_generate():
    assert is_expensive_path("/api/conversations/123/themes/generate") is True


def test_is_expensive_path_ignores_read_routes():
    assert is_expensive_path("/api/conversations") is False


def test_resolve_rate_limit_tier_expensive():
    tier, _limit = resolve_rate_limit_tier("/api/conversations/1/themes/generate", "POST")
    assert tier == "expensive"


def test_resolve_rate_limit_tier_mutate():
    tier, _limit = resolve_rate_limit_tier("/api/import/process-file", "POST")
    assert tier == "mutate"


def test_resolve_rate_limit_tier_read():
    tier, _limit = resolve_rate_limit_tier("/api/conversations", "GET")
    assert tier == "read"