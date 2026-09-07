"""Offline .threads request-budget audit; no inference, source output or writes.

Measures the actual aggregation serializer and envelope, not a tokenizer-based
claim about model capability. The artifact is a workload, not a semantic oracle.
"""
import argparse
import hashlib
import json
from pathlib import Path

from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.source_backed_aggregation import (
    AGGREGATION_SYSTEM_PROMPT, build_aggregation_request,
)


def audit_artifact(artifact, *, context_limit=32768):
    sources = {source['id']: source for source in artifact['utterances']}
    if len(sources) != len(artifact['utterances']):
        raise ValueError('Duplicate source identities in artifact')
    envelope = InferenceEnvelope(
        system_prompt=AGGREGATION_SYSTEM_PROMPT,
        providers=[{'id': 'offline-measurement', 'model': 'never-called',
                    'trust_scope': 'owner_private', 'context_tokens': context_limit}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False},
        output_tokens=4096, headroom_tokens=512,
    )

    def measure(nodes, target):
        request = build_aggregation_request(nodes, sources, target_level=target)
        prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
        # Same serialization as InferenceEnvelope; report bytes explicitly.
        messages = [{'role': 'system', 'content': AGGREGATION_SYSTEM_PROMPT},
                    {'role': 'user', 'content': prompt}]
        units = len(json.dumps(messages, ensure_ascii=False, separators=(',', ':')).encode()) + 4608
        try:
            envelope.validate(prompt)
            fits = True
        except ContextBudgetExceeded:
            fits = False
        return units, fits, len(request['sources'])

    tiers = []
    for target in range(2, 6):
        nodes = [node for node in artifact['graph_data'] if node.get('semantic_level') == target - 1]
        if not nodes:
            continue
        try:
            units, fits, source_count = measure(nodes, target)
        except ValueError as error:
            tiers.append({'target_level': target, 'children': len(nodes),
                          'status': 'invalid_request', 'reason': str(error)})
            continue
        individual = [measure([node], target) for node in nodes]
        tiers.append({'target_level': target, 'children': len(nodes), 'sources': source_count,
                      'envelope_byte_units': units, 'fits': fits,
                      'single_child_over_budget': sum(not item[1] for item in individual),
                      'max_single_child_byte_units': max(item[0] for item in individual)})
    return {'counter': 'utf8_bytes_not_model_tokens', 'context_limit': context_limit,
            'utterances': len(sources),
            'source_text_bytes': sum(len(source['text'].encode()) for source in sources.values()),
            'max_utterance_bytes': max((len(source['text'].encode()) for source in sources.values()), default=0),
            'tiers': tiers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=Path)
    parser.add_argument('--context-limit', type=int, default=32768)
    args = parser.parse_args()
    raw = args.artifact.read_bytes()
    report = audit_artifact(json.loads(raw), context_limit=args.context_limit)
    report['artifact_sha256'] = hashlib.sha256(raw).hexdigest()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
