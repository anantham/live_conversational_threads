"""Explicitly enabled native counter for the approved isolated public replay."""
from importlib.metadata import version
from lct_python_backend.services.transcript.qwen_message_counter import PinnedQwenMessageCounter

TOKENIZER_SHA256 = '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3'


def build_counter(path, *, server_version, expected_sha256=TOKENIZER_SHA256):
    engine_version = version('tokenizers')
    if engine_version != '0.23.0rc0':
        raise ValueError('Replay requires the approved tokenizers==0.23.0rc0 engine')
    from tokenizers import Tokenizer

    def factory(raw):
        encoder = Tokenizer.from_str(raw)
        return lambda text: encoder.encode(text, add_special_tokens=False).ids

    return PinnedQwenMessageCounter(path=path, expected_sha256=expected_sha256,
        tokenizer_factory=factory, engine_id='tokenizers==' + engine_version,
        model='qwen3.8:27b-mlx', server_version=server_version, reasoning_effort='none')
