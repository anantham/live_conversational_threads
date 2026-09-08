"""Intent: count the measured two-message, non-thinking serving contract only.

Verify artifact bytes before constructing the tokenizer; reject extra protocol
features rather than undercounting them. Synthetic encoder tests are not native
tokenizer parity evidence, which is measured separately on public requests.
"""
import hashlib
import pytest
from lct_python_backend.services.transcript.qwen_message_counter import PinnedQwenMessageCounter


def make(tmp_path, **overrides):
    artifact = tmp_path / 'tokenizer.json'
    artifact.write_text('{}', encoding='utf-8')
    options = dict(path=artifact, expected_sha256=hashlib.sha256(b'{}').hexdigest(),
        tokenizer_factory=lambda data: lambda text: list(text.encode('utf-8')),
        engine_id='synthetic-byte-encoder-v1', model='qwen3.8:27b-mlx',
        server_version='0.33.3', reasoning_effort='none')
    options.update(overrides)
    return PinnedQwenMessageCounter(**options)


def test_exact_measured_render_and_empty_user(tmp_path):
    counter = make(tmp_path)
    for text, rendered_text in [('', ''), ('  café\n"quoted"  ', 'café\n"quoted"')]:
        messages = [{'role': 'system', 'content': 'Exact instructions'}, {'role': 'user', 'content': text}]
        rendered = ('<|im_start|>system\nExact instructions<|im_end|>\n<|im_start|>user\n'
                    + rendered_text + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n')
        assert counter(messages) == len(rendered.encode('utf-8'))


def test_bad_digest_rejected_before_tokenizer_constructed(tmp_path):
    with pytest.raises(ValueError, match='digest'):
        make(tmp_path, expected_sha256='0' * 64,
             tokenizer_factory=lambda _: pytest.fail('Unverified bytes reached encoder'))


@pytest.mark.parametrize('override', [{'model': 'other'}, {'server_version': 'unknown'},
    {'reasoning_effort': 'high'}, {'engine_id': ''}])
def test_unknown_contract_is_not_guessed(tmp_path, override):
    with pytest.raises(ValueError):
        make(tmp_path, **override)


@pytest.mark.parametrize('messages', [[], [{'role': 'user', 'content': 'x'}],
    [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': ['image']}],
    [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'x', 'images': []}],
    [{'role': 'system', 'content': 's'}, {'role': 'assistant', 'content': 'x'}]])
def test_extra_protocol_features_fail_closed(tmp_path, messages):
    with pytest.raises(ValueError, match='messages'):
        make(tmp_path)(messages)


def test_identity_binds_tokenizer_engine_and_loaded_bytes_are_detached(tmp_path):
    counter = make(tmp_path)
    before = counter([{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'}])
    (tmp_path / 'tokenizer.json').write_text('changed', encoding='utf-8')
    assert counter([{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'}]) == before
    assert make(tmp_path, engine_id='different-engine').tokenizer_id != counter.tokenizer_id
