import pytest

from lct_python_backend.services.local_llm_client import extract_json_from_text


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
