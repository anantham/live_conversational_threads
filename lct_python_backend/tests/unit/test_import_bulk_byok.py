"""Tests for import_bulk_byok overlay helpers."""

from __future__ import annotations

import pytest

from lct_python_backend.services.import_bulk_byok import (
    apply_llm_byok_overlay,
    apply_stt_byok_overlay,
    resolve_stt_byok_session,
)
from lct_python_backend.services.byok_session_store import ByokSessionLookupError


def test_resolve_stt_byok_session_empty_token():
    assert resolve_stt_byok_session(None) is None
    assert resolve_stt_byok_session("") is None


def test_apply_stt_byok_overlay_without_session():
    runtime, override = apply_stt_byok_overlay(
        {"http_url": "http://localhost:5091"},
        None,
        "whisper",
    )
    assert runtime["http_url"] == "http://localhost:5091"
    assert override == "whisper"


def test_apply_llm_byok_overlay_passthrough():
    cfg = {"mode": "local", "base_url": "http://x"}
    providers = [{"id": "p1", "enabled": True}]
    out_cfg, out_providers = apply_llm_byok_overlay(cfg, providers, None)
    assert out_cfg["mode"] == "local"
    assert out_providers == providers


def test_resolve_stt_byok_session_raises_on_lookup_error(monkeypatch):
    def _boom(_token, required_scope=None):
        raise ByokSessionLookupError("bad token")

    monkeypatch.setattr(
        "lct_python_backend.services.import_bulk_byok.resolve_byok_session",
        _boom,
    )
    with pytest.raises(ValueError, match="bad token"):
        resolve_stt_byok_session("tok")