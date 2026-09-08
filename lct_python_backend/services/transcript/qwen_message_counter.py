"""Opt-in counter for the locally measured Ollama Qwen non-thinking protocol.

No tokenizer dependency import, network access or runtime activation. The trusted
host supplies a factory: verified tokenizer JSON -> encode(text) -> token ID list.
The factory must disable added BOS/EOS tokens. Production use still requires an
approved engine installation and serving-host parity/capacity verification.
"""
import hashlib
import json
from pathlib import Path


class PinnedQwenMessageCounter:
    def __init__(self, *, path, expected_sha256, tokenizer_factory, engine_id,
                 model, server_version, reasoning_effort):
        if (model, server_version, reasoning_effort) != ('qwen3.8:27b-mlx', '0.33.3', 'none'):
            raise ValueError('Unverified model/server/reasoning counter contract')
        if not isinstance(engine_id, str) or not engine_id.strip():
            raise ValueError('Explicit tokenizer engine identity required')
        raw = Path(path).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_sha256:
            raise ValueError('Tokenizer artifact digest mismatch')
        # Construct from these verified bytes, not a second path read that could
        # race replacement of the artifact. The encoder keeps no file dependency.
        self._encode = tokenizer_factory(raw.decode('utf-8', errors='strict'))
        if not callable(self._encode):
            raise ValueError('Tokenizer factory must return an encoder')
        identity = {'artifact_sha256': digest, 'engine': engine_id, 'model': model,
                    'server': server_version, 'reasoning': reasoning_effort,
                    'renderer': 'qwen_two_message_non_thinking_v1'}
        self.tokenizer_id = 'pinned_qwen_' + hashlib.sha256(
            json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def __call__(self, messages):
        if (not isinstance(messages, (list, tuple)) or len(messages) != 2
                or any(not isinstance(m, dict) or set(m) != {'role', 'content'}
                       or not isinstance(m['content'], str) for m in messages)
                or [m['role'] for m in messages] != ['system', 'user']):
            raise ValueError('Counter requires exactly system/user text messages without extra features')
        rendered = ''.join('<|im_start|>' + m['role'] + '\n' + m['content'].strip()
                           + '<|im_end|>\n' for m in messages)
        rendered += '<|im_start|>assistant\n<think>\n\n</think>\n\n'
        ids = self._encode(rendered)
        if not isinstance(ids, (list, tuple)) or any(type(i) is not int or i < 0 for i in ids):
            raise ValueError('Tokenizer must return nonnegative integer token IDs')
        return len(ids)
