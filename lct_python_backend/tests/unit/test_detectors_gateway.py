"""Parity tests for the detector LLM-routing simplification.

The bias/frame/simulacra detectors used to branch local_chat_json (gateway) vs a
hardcoded-model anthropic call. The anthropic branch was vestigial (local-first
repo, no ANTHROPIC_API_KEY) so it was removed — they now always route through the
gateway via local_chat_json. These pin that the per-node output shape is unchanged
and the anthropic path is gone.
"""

import asyncio
import inspect

from lct_python_backend.services import bias_detector as bd
from lct_python_backend.services import frame_detector as fd
from lct_python_backend.services import simulacra_detector as sd


class _Node:
    id = "n1"
    node_name = "Privacy"
    summary = "a point about privacy"
    key_points = ["privacy", "trust"]


def _patch(mod, monkeypatch, response):
    # The detectors route through the shared LLM provider-fallback chain
    # (load_llm_providers + chat_with_provider_fallback, commit 2b841f6) and
    # read the parsed payload off ProviderResult.data.
    class _PM:
        def render_prompt(self, *_a, **_k):
            return "PROMPT"

    class _Result:
        def __init__(self, data):
            self.data = data

    async def _cfg(*_a, **_k):
        return {"providers": [{"id": "local", "base_url": "http://x", "model": "m"}]}

    async def _chat(*_a, **_kw):
        return _Result(response)

    monkeypatch.setattr(mod, "get_prompt_manager", lambda: _PM())
    monkeypatch.setattr(mod, "load_llm_providers", _cfg)
    monkeypatch.setattr(mod, "chat_with_provider_fallback", _chat)


def test_bias_routes_through_gateway(monkeypatch):
    _patch(bd, monkeypatch, {"biases": [{"bias_type": "straw_man", "category": "logical",
                                         "severity": 0.6, "confidence": 0.8, "description": "d", "evidence": []}]})
    out = asyncio.run(bd.BiasDetector(object())._analyze_node(_Node(), "conv"))
    assert isinstance(out, list) and out[0]["bias_type"] == "straw_man"


def test_frame_routes_through_gateway(monkeypatch):
    _patch(fd, monkeypatch, {"frames": [{"frame_type": "market_fundamentalism", "category": "economic"}]})
    out = asyncio.run(fd.FrameDetector(object())._analyze_node(_Node(), "conv"))
    assert isinstance(out, list) and out[0]["frame_type"] == "market_fundamentalism"


def test_simulacra_routes_through_gateway(monkeypatch):
    _patch(sd, monkeypatch, {"level": 3, "confidence": 0.7, "reasoning": "r", "examples": ["e"]})
    out = asyncio.run(sd.SimulacraDetector(object())._analyze_node(_Node()))
    assert out["level"] == 3 and out["confidence"] == 0.7 and out["examples"] == ["e"]


def test_bias_bad_response_returns_empty(monkeypatch):
    _patch(bd, monkeypatch, "not a dict")
    assert asyncio.run(bd.BiasDetector(object())._analyze_node(_Node(), "conv")) == []


def test_no_anthropic_or_hardcoded_model_left():
    for mod in (bd, fd, sd):
        src = inspect.getsource(mod)
        assert "anthropic" not in src, f"{mod.__name__} still references anthropic"
        assert "claude-3-5-sonnet" not in src, f"{mod.__name__} still hardcodes a model"
