"""Test intent: provider truncation is failure even when its text is valid JSON.
Expose safe numeric diagnostics without echoing source or arbitrary response text.
"""
import pytest

from lct_python_backend.services.structured_completion import check_structured_completion


@pytest.mark.parametrize('reason', ['length', 'max_tokens', 'content_filter', 'tool_calls'])
def test_incomplete_structured_output_is_explicit(reason):
    raw = {'choices': [{'finish_reason': reason, 'message': {'content': '{"valid":true}'}}],
           'usage': {'completion_tokens': 4096, 'prompt_tokens': 7200}}
    with pytest.raises(ValueError, match=f'finish_reason={reason}') as error:
        check_structured_completion(raw, output_limit=4096)
    assert 'completion_tokens=4096' in str(error.value)
    assert 'valid' not in str(error.value)


def test_missing_provider_metadata_is_not_invented():
    assert check_structured_completion({'choices': [{}]}, output_limit=512) == {
        'finish_reason': 'unreported', 'completion_tokens': None, 'prompt_tokens': None, 'output_limit': 512}


def test_untrusted_metadata_is_sanitized():
    raw = {'choices': [{'finish_reason': 'private source here'}],
           'usage': {'completion_tokens': 'private source here', 'prompt_tokens': True}}
    metadata = check_structured_completion(raw, output_limit=512)
    assert metadata['finish_reason'] == 'unknown'
    assert metadata['completion_tokens'] is metadata['prompt_tokens'] is None
    assert 'private' not in str(metadata)
