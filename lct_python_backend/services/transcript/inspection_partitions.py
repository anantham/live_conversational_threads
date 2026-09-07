"""Subdivide a processing page without changing original source span identities.

Span-count subdivision addresses output pressure from many input turns; a single
oversized span may still need an additional character-bounded strategy.
"""
import copy

from .source_inspection import validate_inspection


def partition_page(page, span_limit):
    if type(span_limit) is not int or span_limit <= 0:
        raise ValueError('Positive source-span request limit required')
    return [{**copy.deepcopy(page), 'spans': copy.deepcopy(page['spans'][i:i + span_limit]),
             'partition_index': i // span_limit}
            for i in range(0, len(page['spans']), span_limit)]


def merge_partitions(page, receipts):
    if not receipts or [s for r in receipts for s in r['page']['spans']] != page['spans']:
        raise ValueError('Inspection partitions must cover the original page exactly once in order')
    observations, abstentions = [], []
    for index, receipt in enumerate(receipts):
        part, result = receipt['page'], receipt['result']
        if (part.get('partition_index') != index or part['page_index'] != page['page_index']
                or part['source_snapshot_hash'] != page['source_snapshot_hash']):
            raise ValueError('Inspection partition identity mismatch')
        raw = {'reviewed_span_ids': result['reviewed_span_ids'], 'observations': [
            {'kind': o['kind'], 'text': o['text'], 'citations': [
                {k: c[k] for k in ('span_id', 'quote', 'start', 'end')} for c in o['citations']]}
            for o in result['observations']], 'abstention_reason': result.get('abstention_reason')}
        validate_inspection(raw, part)
        observations.extend(raw['observations'])
        if not raw['observations']:
            abstentions.append(raw['abstention_reason'])
    return {'reviewed_span_ids': [s['span_id'] for s in page['spans']],
            'observations': observations, 'abstention_reason': '; '.join(abstentions) or None}
