"""Intent: approved replay counter uses real pinned engine and artifact bytes.

Wrong serving version or artifact digest must fail before a replay starts.
Tests use synthetic tokenizer JSON, not a recording or network request.
"""
import hashlib
import pytest
from tools.public_replay_counter import build_counter


def test_native_counter_and_contract_rejection(tmp_path):
    from tokenizers import Tokenizer, models
    path = tmp_path / 'synthetic-tokenizer.json'
    encoder = Tokenizer(models.WordLevel({'[UNK]': 0}, unk_token='[UNK]'))
    path.write_text(encoder.to_str())
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    counter = build_counter(path, expected_sha256=sha, server_version='0.33.3')
    assert counter([{'role': 'system', 'content': 'Synthetic'}, {'role': 'user', 'content': 'Question'}]) > 0
    with pytest.raises(ValueError, match='digest'):
        build_counter(path, expected_sha256='0' * 64, server_version='0.33.3')
    with pytest.raises(ValueError, match='contract'):
        build_counter(path, expected_sha256=sha, server_version='unknown')
