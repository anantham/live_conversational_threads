"""Tests for LLM live telemetry (ADR-037).

JSONL-backed; we point the log at a temp file so nothing touches the real data dir.
"""

import asyncio

import pytest

from lct_python_backend.services import llm_telemetry_service as t
from lct_python_backend.services.llm_telemetry_service import (
    aggregate_llm_telemetry,
    catalog_provider_key,
    record_llm_call,
)


# NB: the parametrized arg is deliberately NOT named `base_url` — that name
# collides with the session-scoped `base_url` fixture from the pytest-base-url
# plugin (installed with playwright-pytest), causing a ScopeMismatch error on
# any machine that has it.
@pytest.mark.parametrize("url,ptype,expected", [
    ("http://127.0.0.1:11434", "openai_compatible", "local_ollama"),
    ("http://100.81.65.74:1234", "openai_compatible", "tailscale_rtx"),
    ("https://openrouter.ai/api", "openrouter", "cloud_openrouter"),
    ("https://api.openai.com", "openai", "cloud_openai"),
    ("http://127.0.0.1:1234", "openai_compatible", "local_lmstudio"),
    ("https://generativelanguage.googleapis.com", "openai_compatible", "cloud_gemini"),
])
def test_catalog_provider_key(url, ptype, expected):
    assert catalog_provider_key(url, ptype) == expected


def test_record_and_aggregate_roundtrip(tmp_path, monkeypatch):
    scratch = str(tmp_path / "llm_telemetry.jsonl")
    monkeypatch.setattr(t, "_telemetry_path", lambda: scratch)

    record_llm_call(provider_key="local_ollama", model="gpt-oss-20b", base_url="http://127.0.0.1:11434",
                    total_ms=3200.0, prompt_tokens=1500, completion_tokens=640, ok=True, valid_json=True)
    record_llm_call(provider_key="local_ollama", model="gpt-oss-20b", base_url="http://127.0.0.1:11434",
                    total_ms=2800.0, prompt_tokens=1200, completion_tokens=520, ok=True, valid_json=False)

    agg = asyncio.run(aggregate_llm_telemetry(None, 400))
    bucket = agg["providers"]["local_ollama"]
    assert bucket["samples"] == 2
    # 640/3.2 = 200, 520/2.8 = 185.71 -> avg ~192.86
    assert 190 <= bucket["avg_tokens_per_sec"] <= 196
    assert bucket["valid_json_rate"] == 0.5  # one True, one False
    assert bucket["last_model"] == "gpt-oss-20b"


def test_record_swallows_write_error(monkeypatch):
    # an unwritable path must NOT raise (telemetry can never break generation)
    monkeypatch.setattr(t, "_telemetry_path", lambda: "/nonexistent-dir-xyz/\x00/bad.jsonl")
    record_llm_call(provider_key="x", model="m", base_url="b", total_ms=10.0, completion_tokens=5)


def test_tokens_per_sec_none_without_completion_tokens(tmp_path, monkeypatch):
    scratch = str(tmp_path / "t.jsonl")
    monkeypatch.setattr(t, "_telemetry_path", lambda: scratch)
    record_llm_call(provider_key="p", model="m", base_url="b", total_ms=1000.0, completion_tokens=None)
    agg = asyncio.run(aggregate_llm_telemetry(None, 400))
    assert agg["providers"]["p"]["avg_tokens_per_sec"] is None
