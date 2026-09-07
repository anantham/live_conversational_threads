"""One synthetic inspection on the existing local model, no retries or writes.

This is a citation/meaning diagnostic, not a full-podcast quality benchmark.
"""
import json
import time

from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.source_inspection import INSPECTION_PROMPT, validate_inspection
from lct_python_backend.services.transcript.source_inspection_pages import plan_inspection_pages


def main():
    sources = [
        {'id': 'synthetic-a', 'sequence_number': 1, 'speaker_id': 'Nora', 'speaker_revision': 0,
         'text': 'Who may borrow the spare key? We have not agreed on that yet. I am asking about borrowing, not making copies.'},
        {'id': 'synthetic-b', 'sequence_number': 2, 'speaker_id': 'Luis', 'speaker_revision': 0,
         'text': 'Venus was bright yesterday. Returning to your question, the manager permits two copies, but that does not answer whether visitors may borrow one.'},
    ]
    envelope = InferenceEnvelope(system_prompt=INSPECTION_PROMPT,
        providers=[{'id': 'local-inspection-probe', 'model': 'qwen3.8:27b-mlx',
            'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
            'trust_scope': 'owner_private', 'context_tokens': 32768, 'timeout_seconds': 180}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False},
        output_tokens=2048, headroom_tokens=512, temperature=0)
    page = plan_inspection_pages(sources, envelope=envelope)[0]
    print(json.dumps({'phase': 'requesting', 'source_characters': 254,
                      'policy_fingerprint': envelope.fingerprint}), flush=True)
    start = time.monotonic()
    result = envelope.complete_json(json.dumps(page, ensure_ascii=False, separators=(',', ':')))
    try:
        status = {'valid': True, 'result': validate_inspection(result.data, page)}
    except ValueError as error:
        status = {'valid': False, 'error': str(error), 'raw_result': result.data}
    print(json.dumps({'phase': 'complete', 'seconds': round(time.monotonic() - start, 2), **status}), flush=True)


if __name__ == '__main__':
    main()
