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


def get_node_by_name(graph_data, node_name):
    for node in graph_data:
        if node.get("node_name") == node_name:
            return node
    return None


def generate_formalism(chunks: dict, graph_data: dict, user_pref: str) -> List:
    formalism_list = []
    for node in graph_data[0]:
        contextual_node = ''
        related_nodes = ''
        raw_text = ''
        loopy_url = None
        if 'is_contextual_progress' in node and node['is_contextual_progress']:
            contextual_node = str(node)
            for n in node['linked_nodes']:
                related_nodes += "\n" + str(get_node_by_name(graph_data[0], n))
            chunk_id = node['chunk_id']
            raw_text = chunks[chunk_id]

            # NOTE: generate_individual_formalism is undefined — this branch
            # would NameError if reached. Endpoint /generate_formalism/ has
            # been latent-broken; leaving the structural code so the bug is
            # visible. Fix or remove the endpoint separately.
            formalism_input = f"conversation_data: \n contextual node : \n {contextual_node} \n related nodes : \n {related_nodes} \n user_research_background \n {user_pref} \n raw_text : \n {raw_text}"
            loopy_url = generate_individual_formalism(formalism_input=formalism_input)  # noqa: F821
            if loopy_url:
                formalism_list.append({
                    'formalism_node': node['node_name'],
                    'formalism_graph_url': loopy_url,
                })
    return formalism_list
