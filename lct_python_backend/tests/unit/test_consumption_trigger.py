"""Unit tests for consumption_trigger.

Focus areas:
- Config flag/env handling (disabled-by-default, threshold override, model resolution).
- Prompt assembly is deterministic (so the prompt-eval harness can pin behaviour).
- parse_llm_response tolerates the messy real-world LLM output shapes
  (json_object dict, raw text with fences, prose around JSON, missing fields).
- detect_consumption_trigger never raises — every failure path returns a
  ConsumptionTriggerResult with error_note set. This is load-bearing: a
  silent exception in the live STT path would interrupt the user's
  conversation.
- Confidence threshold demotes high-confidence-trigger to no-trigger.
"""

import pytest

from lct_python_backend.experimental import consumption_trigger as ct


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in (
        "CONSUMPTION_TRIGGER_ENABLED",
        "CONSUMPTION_TRIGGER_MODEL",
        "CONSUMPTION_TRIGGER_THRESHOLD",
        "CONSUMPTION_TRIGGER_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def test_disabled_by_default():
    assert ct.is_enabled() is False


@pytest.mark.parametrize("val", ["true", "True", "1", "yes", "on"])
def test_enabled_when_flag_set(monkeypatch, val):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_ENABLED", val)
    assert ct.is_enabled() is True


@pytest.mark.parametrize("val", ["false", "0", "no", "off", ""])
def test_disabled_for_falsy_values(monkeypatch, val):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_ENABLED", val)
    assert ct.is_enabled() is False


def test_default_threshold():
    assert ct.get_threshold() == 0.6


def test_threshold_override(monkeypatch):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_THRESHOLD", "0.75")
    assert ct.get_threshold() == 0.75


def test_threshold_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_THRESHOLD", "not-a-number")
    assert ct.get_threshold() == 0.6


def test_model_override(monkeypatch):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_MODEL", "google/gemma-3-12b")
    assert ct.get_model() == "google/gemma-3-12b"


def test_model_default_falls_back_to_system(monkeypatch):
    # Even without an override, get_model returns something callable
    monkeypatch.delenv("CONSUMPTION_TRIGGER_MODEL", raising=False)
    model = ct.get_model()
    assert isinstance(model, str) and len(model) > 0


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

def test_build_prompt_includes_segment():
    msgs = ct.build_prompt(
        segment_text="we should talk about money and parents",
        active_threads=None,
        recent_segments=None,
    )
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert "money and parents" in msgs[1]["content"]


def test_build_prompt_formats_threads():
    msgs = ct.build_prompt(
        segment_text="x",
        active_threads=["circular economy", "weekend plans"],
        recent_segments=None,
    )
    content = msgs[1]["content"]
    assert "- circular economy" in content
    assert "- weekend plans" in content


def test_build_prompt_caps_threads():
    threads = [f"thread_{i}" for i in range(20)]
    msgs = ct.build_prompt(segment_text="x", active_threads=threads, recent_segments=None)
    content = msgs[1]["content"]
    # Default cap is 6
    assert "- thread_5" in content
    assert "- thread_6" not in content


def test_build_prompt_uses_only_recent_segments():
    segments = ["very old segment", "old segment", "recent segment"]
    msgs = ct.build_prompt(segment_text="x", active_threads=None, recent_segments=segments)
    content = msgs[1]["content"]
    # Default takes last 2
    assert "recent segment" in content
    assert "old segment" in content
    assert "very old segment" not in content


def test_build_prompt_handles_no_threads_or_recents():
    msgs = ct.build_prompt(segment_text="x", active_threads=None, recent_segments=None)
    content = msgs[1]["content"]
    assert "(none yet)" in content
    assert "(none — this is the first segment)" in content


# ---------------------------------------------------------------------------
# parse_llm_response — happy path + edge cases
# ---------------------------------------------------------------------------

def _wrap_content_str(s: str) -> dict:
    return {"choices": [{"message": {"content": s}}]}


def _wrap_content_dict(d: dict) -> dict:
    return {"choices": [{"message": {"content": d}}]}


def test_parse_dict_content():
    body = _wrap_content_dict({
        "has_trigger": True,
        "topic_hints": ["money", "parents"],
        "confidence": 0.82,
        "reasoning": "speaker said 'we should talk about'",
    })
    r = ct.parse_llm_response(body)
    assert r.has_trigger is True
    assert r.topic_hints == ["money", "parents"]
    assert r.confidence == 0.82
    assert "we should talk" in r.reasoning


def test_parse_string_content():
    body = _wrap_content_str(
        '{"has_trigger": true, "topic_hints": ["x"], "confidence": 0.9, "reasoning": "y"}'
    )
    r = ct.parse_llm_response(body)
    assert r.has_trigger is True
    assert r.confidence == 0.9


def test_parse_string_content_with_fences():
    body = _wrap_content_str(
        '```json\n{"has_trigger": false, "topic_hints": [], "confidence": 0.2, "reasoning": "fresh question"}\n```'
    )
    r = ct.parse_llm_response(body)
    assert r.has_trigger is False
    assert r.topic_hints == []


def test_parse_string_content_with_prose_around_json():
    body = _wrap_content_str(
        'Here is my answer: {"has_trigger": true, "topic_hints": ["a"], "confidence": 0.7, "reasoning": "ok"}'
    )
    r = ct.parse_llm_response(body)
    assert r.has_trigger is True


def test_parse_has_trigger_as_string():
    body = _wrap_content_dict({"has_trigger": "true", "topic_hints": [], "confidence": 0.7, "reasoning": ""})
    r = ct.parse_llm_response(body)
    assert r.has_trigger is True


def test_parse_confidence_clamped():
    body = _wrap_content_dict({"has_trigger": True, "topic_hints": [], "confidence": 1.5, "reasoning": ""})
    assert ct.parse_llm_response(body).confidence == 1.0

    body2 = _wrap_content_dict({"has_trigger": True, "topic_hints": [], "confidence": -0.2, "reasoning": ""})
    assert ct.parse_llm_response(body2).confidence == 0.0


def test_parse_confidence_invalid_defaults_zero():
    body = _wrap_content_dict({"has_trigger": True, "topic_hints": [], "confidence": "very", "reasoning": ""})
    assert ct.parse_llm_response(body).confidence == 0.0


def test_parse_topic_hints_as_comma_string():
    body = _wrap_content_dict({"has_trigger": True, "topic_hints": "money, parents, family", "confidence": 0.7})
    r = ct.parse_llm_response(body)
    assert r.topic_hints == ["money", "parents", "family"]


def test_parse_topic_hints_filters_empties():
    body = _wrap_content_dict({"has_trigger": True, "topic_hints": ["a", "", "  ", "b"], "confidence": 0.7})
    r = ct.parse_llm_response(body)
    assert r.topic_hints == ["a", "b"]


def test_parse_missing_fields_defaults():
    body = _wrap_content_dict({})  # nothing
    r = ct.parse_llm_response(body)
    assert r.has_trigger is False
    assert r.confidence == 0.0
    assert r.topic_hints == []
    assert r.reasoning == ""


def test_parse_empty_string_raises():
    with pytest.raises(ValueError):
        ct.parse_llm_response(_wrap_content_str(""))


def test_parse_missing_choices_raises():
    with pytest.raises(ValueError):
        ct.parse_llm_response({})


def test_parse_non_dict_parsed_raises():
    # Content is valid JSON but a list, not a dict
    body = _wrap_content_str('[1, 2, 3]')
    with pytest.raises(ValueError):
        ct.parse_llm_response(body)


# ---------------------------------------------------------------------------
# detect_consumption_trigger — top-level orchestration
# ---------------------------------------------------------------------------

class _StubClient:
    """Replaces LocalLLMClient for tests; deterministic outputs."""
    def __init__(self, response=None, exception=None):
        self.response = response
        self.exception = exception
        self.called_with = None

    async def chat(self, *, model, messages, temperature=0.3, max_tokens=4000, response_format=None):
        self.called_with = {
            "model": model, "messages": messages,
            "temperature": temperature, "max_tokens": max_tokens,
        }
        if self.exception:
            raise self.exception
        return self.response


@pytest.fixture
def _patch_client(monkeypatch):
    """Returns a function that installs a stub client + returns it."""
    def _install(stub: _StubClient):
        monkeypatch.setattr(
            "lct_python_backend.experimental.consumption_trigger.get_local_client",
            lambda config=None: stub,
        )
        return stub
    return _install


@pytest.mark.asyncio
async def test_empty_segment_returns_false_no_call(_patch_client):
    stub = _patch_client(_StubClient(response={}))
    result = await ct.detect_consumption_trigger(segment_text="")
    assert result.has_trigger is False
    assert result.error_note == "empty segment_text"
    assert stub.called_with is None  # never called the LLM


@pytest.mark.asyncio
async def test_llm_exception_returns_error_note(_patch_client):
    _patch_client(_StubClient(exception=RuntimeError("server boom")))
    result = await ct.detect_consumption_trigger(segment_text="real segment text")
    assert result.has_trigger is False
    assert "boom" in result.error_note


@pytest.mark.asyncio
async def test_llm_high_confidence_trigger(_patch_client, monkeypatch):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_THRESHOLD", "0.6")
    _patch_client(_StubClient(response=_wrap_content_dict({
        "has_trigger": True,
        "topic_hints": ["money", "parents"],
        "confidence": 0.85,
        "reasoning": "speaker brought up 'we should talk about money'",
    })))
    result = await ct.detect_consumption_trigger(segment_text="we should talk about money")
    assert result.has_trigger is True
    assert result.topic_hints == ["money", "parents"]
    assert result.confidence == 0.85
    assert result.error_note is None


@pytest.mark.asyncio
async def test_llm_below_threshold_demoted(_patch_client, monkeypatch):
    monkeypatch.setenv("CONSUMPTION_TRIGGER_THRESHOLD", "0.6")
    _patch_client(_StubClient(response=_wrap_content_dict({
        "has_trigger": True,
        "topic_hints": ["maybe"],
        "confidence": 0.45,  # below threshold
        "reasoning": "uncertain",
    })))
    result = await ct.detect_consumption_trigger(segment_text="something")
    assert result.has_trigger is False  # demoted
    assert result.confidence == 0.45
    # Hints preserved for telemetry
    assert result.topic_hints == ["maybe"]


@pytest.mark.asyncio
async def test_llm_explicit_no_trigger(_patch_client):
    _patch_client(_StubClient(response=_wrap_content_dict({
        "has_trigger": False,
        "topic_hints": [],
        "confidence": 0.95,
        "reasoning": "fresh new statement",
    })))
    result = await ct.detect_consumption_trigger(segment_text="something new")
    assert result.has_trigger is False
    assert result.error_note is None  # not an error; LLM said no clearly


@pytest.mark.asyncio
async def test_llm_garbage_response_returns_error_note(_patch_client):
    _patch_client(_StubClient(response=_wrap_content_str("totally not JSON at all")))
    result = await ct.detect_consumption_trigger(segment_text="x")
    assert result.has_trigger is False
    assert "unparseable" in result.error_note


@pytest.mark.asyncio
async def test_segment_text_reaches_prompt(_patch_client):
    stub = _patch_client(_StubClient(response=_wrap_content_dict(
        {"has_trigger": False, "topic_hints": [], "confidence": 0.1, "reasoning": ""}
    )))
    await ct.detect_consumption_trigger(
        segment_text="remember the thing about money?",
        active_threads=["bangalore travel"],
        recent_segments=["earlier we discussed routes"],
    )
    user_msg = stub.called_with["messages"][1]["content"]
    assert "remember the thing about money" in user_msg
    assert "- bangalore travel" in user_msg
    assert "earlier we discussed routes" in user_msg
