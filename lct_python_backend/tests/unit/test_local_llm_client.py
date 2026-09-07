"""Test intent: parse complete outer containers, never nested fragments from
truncated JSON; preserve supported wrappers and complete arrays/objects.
"""
import json
import pytest

from lct_python_backend.services.local_llm_client import ProviderResult, extract_json_from_text


def test_extract_json_from_text_handles_think_prefix():
    payload = "<think>reasoning...</think>\n[{\"node_name\":\"A\"}]"
    parsed = extract_json_from_text(payload)
    assert isinstance(parsed, list)
    assert parsed[0]["node_name"] == "A"


def test_extract_json_from_text_handles_trailing_non_json_text():
    payload = "{\"decision\":\"stop_accumulating\"}\nextra trailing notes"
    parsed = extract_json_from_text(payload)
    assert isinstance(parsed, dict)
    assert parsed["decision"] == "stop_accumulating"


def test_extract_json_from_text_raises_on_missing_json():
    with pytest.raises(Exception):
        extract_json_from_text("<think>only reasoning without payload</think>")


@pytest.mark.parametrize('payload', [
    '{"reviewed_span_ids":["s1","s2"],"observations":[',
    '{"outer":{"valid":"nested"},"broken":',
    '```json\n{"outer":[1,2],"broken":\n```',
    'Here is the result: {"outer":[1,2],"broken":',
])
def test_incomplete_outer_container_never_returns_valid_inner_fragment(payload):
    with pytest.raises(json.JSONDecodeError):
        extract_json_from_text(payload)


def test_complete_fenced_and_prefaced_objects_remain_supported():
    assert extract_json_from_text('```json\n{"ok":true}\n```') == {'ok': True}
    assert extract_json_from_text('Result: [{"ok":true}]\nDone.') == [{'ok': True}]


def test_provider_result_backend_label_prefers_openai_provider_type():
    result = ProviderResult(
        data={},
        provider_id="byok-openai",
        provider_name="BYOK OpenAI",
        model="gpt-4.1-mini",
        base_url="https://api.openai.com/v1",
        provider_type="openai",
    )

    assert result.backend_label() == "openai_gpt-4.1-mini"


def test_provider_result_backend_label_marks_nonlocal_compatible_hosts_as_remote():
    result = ProviderResult(
        data={},
        provider_id="remote-compatible",
        provider_name="Remote Compatible",
        model="gpt-4.1-mini",
        base_url="https://llm.example.com/v1",
        provider_type="openai_compatible",
    )

    assert result.backend_label() == "remote_gpt-4.1-mini"
