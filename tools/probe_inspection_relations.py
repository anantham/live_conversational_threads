"""Synthetic cross-page retrieval/relation probe on installed local models.

Uses source-validated synthetic test observations, not real model inspection.
Embeddings and relation interpretation are real local calls. No retries/writes.
"""
import asyncio
import json
import time

from lct_python_backend.tests.unit.test_inspection_context import fixture
from lct_python_backend.services.transcript.inspection_context import plan_inspection_context
from lct_python_backend.services.transcript.inspection_relations import RELATION_PROMPT, review_inspection_context
from lct_python_backend.services.transcript.semantic_candidates import SemanticCandidates
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope


async def main():
    snapshot, receipts = fixture()
    focal = receipts[-2]['result']['observations'][0]['id']
    retriever = SemanticCandidates(providers=[{'id': 'local-inspection-retrieval',
        'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
        'embedding_model': 'qwen3-embedding:0.6b', 'trust_scope': 'owner_private', 'timeout_seconds': 180}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False})
    envelope = InferenceEnvelope(system_prompt=RELATION_PROMPT,
        providers=[{'id': 'local-relation-probe', 'type': 'openai_compatible',
            'base_url': 'http://127.0.0.1:11434', 'model': 'qwen3.8:27b-mlx',
            'trust_scope': 'owner_private', 'context_tokens': 32768, 'timeout_seconds': 180}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False},
        output_tokens=2048, headroom_tokens=512, temperature=0)
    print(json.dumps({'phase': 'requesting', 'intervening_remarks': 45}), flush=True)
    start = time.monotonic()
    prompt = await plan_inspection_context(snapshot, receipts, focal_id=focal,
        available_through_sequence=47, envelope=envelope, retriever=retriever, max_candidates=3)
    result = await review_inspection_context(prompt, envelope=envelope)
    print(json.dumps({'phase': 'complete', 'seconds': round(time.monotonic() - start, 2),
                      'result': result}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
