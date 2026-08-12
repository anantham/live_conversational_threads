"""Content-addressed LLM cache (services/llm_cache.py).

A Phase-2 extract of 1,125 turns took 126 MINUTES and re-running it repeated
every call, including ~1,080 three-second "keep accumulating" decisions whose
inputs never changed. These tests pin the CORRECTNESS of the key: anything
that can change the answer must invalidate, or the cache would serve a stale
answer to a new question.
"""
from __future__ import annotations

import pytest

from lct_python_backend.services import llm_cache as lc


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LCT_LLM_CACHE", "1")
    monkeypatch.setenv("LCT_LLM_CACHE_PATH", str(tmp_path / "c.sqlite3"))


_MSGS = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]
_ARGS = dict(temperature=0.3, max_tokens=4000, require_json=True,
             prompt_name="consolidate_ideas_to_topics", prompt_version="1",
             models=["gemma4:latest"])


def test_roundtrip():
    k = lc.cache_key(_MSGS, **_ARGS)
    assert lc.get(k) is None
    lc.put(k, {"nodes": [1, 2]}, "gemma4:latest", "p")
    hit = lc.get(k)
    assert hit and hit["data"] == {"nodes": [1, 2]} and hit["model"] == "gemma4:latest"


def test_same_inputs_same_key():
    assert lc.cache_key(_MSGS, **_ARGS) == lc.cache_key(list(_MSGS), **_ARGS)


@pytest.mark.parametrize("field,value", [
    ("temperature", 0.9),
    ("max_tokens", 8000),
    ("require_json", False),
    ("prompt_version", "1+antisingleton-2026-08-11"),
    ("prompt_name", "consolidate_topics_to_themes"),
])
def test_every_answer_changing_field_invalidates(field, value):
    """A PROMPT EDIT is the dangerous one: without prompt_version in the key,
    a re-extract after tuning a prompt would replay the OLD answers and look
    like the tuning did nothing."""
    other = dict(_ARGS, **{field: value})
    assert lc.cache_key(_MSGS, **_ARGS) != lc.cache_key(_MSGS, **other)


def test_model_swap_invalidates():
    other = dict(_ARGS, models=["muse-glimmer:30b-mlx"])
    assert lc.cache_key(_MSGS, **_ARGS) != lc.cache_key(_MSGS, **other)


def test_provider_ORDER_does_not_fragment_the_cache():
    a = dict(_ARGS, models=["gemma4:latest", "muse:30b"])
    b = dict(_ARGS, models=["muse:30b", "gemma4:latest"])
    assert lc.cache_key(_MSGS, **a) == lc.cache_key(_MSGS, **b)


def test_different_message_text_invalidates():
    other = [{"role": "system", "content": "sys"},
             {"role": "user", "content": "a DIFFERENT question"}]
    assert lc.cache_key(_MSGS, **_ARGS) != lc.cache_key(other, **_ARGS)


def test_disabled_reads_and_writes_are_inert(monkeypatch):
    k = lc.cache_key(_MSGS, **_ARGS)
    lc.put(k, {"x": 1}, "m", "p")
    monkeypatch.setenv("LCT_LLM_CACHE", "0")
    assert lc.get(k) is None          # no serving while disabled
    lc.put(k, {"x": 2}, "m", "p")     # and no writing either
    monkeypatch.setenv("LCT_LLM_CACHE", "1")
    assert lc.get(k)["data"] == {"x": 1}


def test_unwritable_path_degrades_instead_of_raising(monkeypatch, tmp_path):
    monkeypatch.setenv("LCT_LLM_CACHE_PATH", str(tmp_path / "x.sqlite3" / "nope.db"))
    k = lc.cache_key(_MSGS, **_ARGS)
    assert lc.get(k) is None
    lc.put(k, {"x": 1}, "m", "p")     # must not raise


def test_stats_reports_entries():
    lc.put(lc.cache_key(_MSGS, **_ARGS), {"x": 1}, "m", "p")
    s = lc.stats()
    assert s["entries"] == 1 and s["enabled"] is True
