"""Generation-API helpers — chunking + streaming JSON generation.

Historical note: this module used to host a direct Anthropic Claude
path (`claude_llm_call`, `generate_lct_json_claude`) that was replaced
by the gateway-routed `generate_lct_json` flow but never deleted.
Those functions were removed 2026-05-17. New LLM calls should go
through `lct_python_backend.services.llm_gateway.gateway()` per
ADR-030 §D5.
"""
import json
import logging
import time
from typing import Dict, Generator, List

from lct_python_backend.services.transcript_processing import generate_lct_json

logger = logging.getLogger(__name__)



def stream_generate_context_json(chunks: Dict[str, str]) -> Generator[str, None, None]:
    if not isinstance(chunks, dict):
        raise TypeError("The chunks must be a dictionary.")

    existing_json = []

    for chunk_id, chunk_text in chunks.items():
        mod_input = f'Existing JSON : \n {repr(existing_json)} \n\n Transcript Input: \n {chunk_text}'
        output_json, _backend = generate_lct_json(mod_input)

        if output_json is None:
            yield json.dumps(existing_json)  # Send whatever we have so far
            continue

        for item in output_json:
            item["chunk_id"] = chunk_id  # Attach chunk ID

        existing_json.extend(output_json)
        yield json.dumps(existing_json)
        time.sleep(0.5)


def sliding_window_chunking(text: str, chunk_size: int = 10000, overlap: int = 2000) -> Dict[str, str]:
    import uuid
    assert chunk_size > overlap, "chunk_size must be greater than overlap!"

    words = text.split()
    chunks = {}
    start = 0

    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk_text = " ".join(words[start:end])
        chunks[str(uuid.uuid4())] = chunk_text
        start += chunk_size - overlap

    return chunks


