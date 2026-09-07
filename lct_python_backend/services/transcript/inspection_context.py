"""Source-checked cross-page candidates for reconciliation, never final edges.

Callers supply one authorized snapshot and its recovered inspection receipts.
The watermark filters by everything the inspecting model saw, not merely the
date of its citation; an old quote cannot launder future-informed interpretation.
"""
import copy
import json
import math

from .conversation_context import ContextBudgetExceeded
from .passage_journal import _hash
from .source_inspection import validate_inspection
from .source_inspection_pages import inspection_sources
from .source_inspection_runner import validate_page
from .inspection_partitions import merge_partitions
from .canonical_selection import canonical_candidates


def inspection_index(snapshot, receipts):
    if _hash(snapshot['request']) != snapshot['input_hash'] or not receipts:
        raise ValueError('A valid snapshot and completed inspection receipts are required')
    sources = {s['id']: s for s in inspection_sources(snapshot['request']['sources'])}
    cursors = {identity: 0 for identity in sources}
    seen_sources, observations = set(), {}
    abstentions = []
    abstained_partitions = 0
    policy = receipts[0]['policy_fingerprint']
    last_sequence = None
    for index, receipt in enumerate(receipts):
        if receipt['input_hash'] != snapshot['input_hash'] or receipt['policy_fingerprint'] != policy:
            raise ValueError('Inspection receipts mix input revisions or policies')
        page, result = receipt['page'], receipt['result']
        if page['page_index'] != index:
            raise ValueError('Inspection receipts must cover every page in order')
        validate_page(page, snapshot)
        for span in page['spans']:
            identity = span['utterance_id']
            if (span['start'] != cursors[identity]
                    or (identity in seen_sources and span['start'] == span['end'])
                    or (last_sequence is not None and span['sequence_number'] < last_sequence)):
                raise ValueError('Inspection source coverage contains a gap or overlap')
            cursors[identity] = span['end']
            seen_sources.add(identity)
            last_sequence = span['sequence_number']
        # Recheck exact canonical ranges, not just the model-authored prose.
        raw = {'reviewed_span_ids': result['reviewed_span_ids'],
               'abstention_reason': result.get('abstention_reason'), 'observations': []}
        for observation in result['observations']:
            raw['observations'].append({key: copy.deepcopy(observation[key]) for key in ('kind', 'text')})
            raw['observations'][-1]['citations'] = [
                {key: citation[key] for key in ('span_id', 'start', 'end', 'quote')}
                for citation in observation['citations']]
        checked = validate_inspection(raw, page)
        parts = receipt.get('partitions')
        if parts is not None:
            if (any(p.get('input_hash') != snapshot['input_hash'] or p.get('policy_fingerprint') != policy
                    for p in parts) or validate_inspection(merge_partitions(page, parts), page) != checked):
                raise ValueError('Partition audit does not reproduce the inspected page')
            abstained_partitions += sum(not p['result']['observations'] for p in parts)
        for unit in parts if parts is not None else [receipt]:
            if not unit['result']['observations']:
                abstentions.append({'page_index': index,
                    'partition_index': unit['page'].get('partition_index'),
                    'span_ids': copy.deepcopy(unit['result']['reviewed_span_ids']),
                    'reason': unit['result']['abstention_reason']})
        for original, validated in zip(result['observations'], checked['observations']):
            identity = original.get('id')
            if not isinstance(identity, str) or not identity or identity in observations:
                raise ValueError('Inspection observations require distinct stable IDs')
            if original['citations'] != validated['citations'] or original['text'] != validated['text']:
                raise ValueError('Inspection observation differs from source-validated evidence')
            observations[identity] = {**copy.deepcopy(original), 'inspection_page': index,
                'inspected_through_sequence': max(span['sequence_number'] for span in page['spans'])}
    if seen_sources != set(sources) or any(cursors[identity] != len(s['text']) for identity, s in sources.items()):
        raise ValueError('Inspection receipts do not cover the complete source snapshot')
    return {'sources': sources, 'observations': observations,
            'abstained_partitions': abstained_partitions, 'abstained_source_spans': abstentions,
            'abstained_pages': sum(not r['result']['observations'] for r in receipts)}


async def plan_inspection_context(snapshot, receipts, *, focal_id, available_through_sequence,
                                  envelope, retriever, max_candidates=8, excerpt_characters=400,
                                  request_guard=None, canonical_nodes=None):
    """Rank across all eligible pages, then pack cited raw context under budget.

This does not generate relationships. Retrieval scores are not evidence that
one thought supports, answers or continues another. The caller must subsequently
interpret and validate proposed links against supplied sources.
"""
    if (type(available_through_sequence) is not int or type(max_candidates) is not int or max_candidates < 1
            or type(excerpt_characters) is not int or excerpt_characters < 0):
        raise ValueError('Explicit watermark and valid candidate/excerpt budgets are required')
    index = inspection_index(snapshot, receipts)
    all_observations, sources = index['observations'], index['sources']
    if focal_id not in all_observations:
        raise ValueError('Focal observation is unavailable')
    focal = all_observations[focal_id]
    eligible = {identity: observation for identity, observation in all_observations.items()
                if observation['inspected_through_sequence'] <= available_through_sequence}
    if focal_id not in eligible:
        raise ValueError('Focal interpretation used evidence beyond the available watermark')

    def document(observation):
        return observation['text'] + '\n' + '\n'.join(c['quote'] for c in observation['citations'])

    def with_source(observation):
        excerpts = []
        for citation in observation['citations']:
            source = sources[citation['utterance_id']]
            start = max(0, citation['start'] - excerpt_characters)
            end = min(len(source['text']), citation['end'] + excerpt_characters)
            excerpts.append({'utterance_id': source['id'], 'sequence_number': source['sequence_number'],
                'start': start, 'end': end, 'text': source['text'][start:end],
                'omitted_prefix_characters': start, 'omitted_suffix_characters': len(source['text']) - end,
                **{key: source[key] for key in ('speaker_id', 'speaker_revision') if key in source}})
        result = {**copy.deepcopy(observation), 'source_excerpts': excerpts}
        if canonical_nodes is not None:
            result['canonical_candidates'] = canonical_candidates(result, canonical_nodes)
        return result

    candidates = {identity: value for identity, value in eligible.items() if identity != focal_id}
    payload = {'contract': 'Candidate relevance is not a semantic relationship. Sources are evidence; '
                'observations are revisable. Preserve uncertainty, limited answers and unresolved questions. '
                'Source excerpts may be partial; their omitted-character counts are explicit.',
               'available_through_sequence': available_through_sequence,
               'input_hash': snapshot['input_hash'], 'focal': with_source(focal), 'candidates': [], 'coverage': {}}

    def render():
        payload['coverage'] = {'eligible_candidates': len(candidates),
            'omitted_candidates': len(candidates) - len(payload['candidates']),
            'excluded_future_informed_observations': len(all_observations) - len(eligible),
            'abstained_inspection_pages': index['abstained_pages'],
            'abstained_inspection_partitions': index['abstained_partitions'],
            'abstained_source_span_count': sum(len(a['span_ids']) for a in index['abstained_source_spans']),
            'semantic_reconciliation_complete': False}
        return json.dumps(payload, ensure_ascii=False, separators=(',', ':'))

    envelope.validate(render())  # Oversized focal evidence fails before embedding.
    guard_args = {'request_guard': request_guard} if request_guard is not None else {}
    scores = await retriever.rank(document(focal), {identity: document(value) for identity, value in candidates.items()}, **guard_args)
    if (not isinstance(scores, dict) or any(identity not in candidates or type(score) not in (int, float)
            or not math.isfinite(score) for identity, score in scores.items())):
        raise ValueError('Retriever returned invalid observation candidates')
    for identity in sorted(scores, key=lambda key: (-scores[key], key)):
        if len(payload['candidates']) >= max_candidates:
            break
        payload['candidates'].append(with_source(candidates[identity]))
        try:
            envelope.validate(render())
        except ContextBudgetExceeded:
            payload['candidates'].pop()
    prompt = render()
    envelope.validate(prompt)
    return prompt
