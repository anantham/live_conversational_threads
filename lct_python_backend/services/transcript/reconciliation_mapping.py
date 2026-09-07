"""Map source-reviewed observation endpoints to canonical leaf candidates.

Shared source IDs are not enough to choose between several moments. Preserve
those ambiguities for semantic adjudication instead of guessing by position,
name similarity, or the presence/absence of a representative display excerpt.
"""
from .inspection_relations import validate_relation_review
from .passage_journal import _hash


def map_reviewed_relations(review, context, nodes):
    if review.get('context_hash') != _hash(context):
        raise ValueError('Relation review does not match its inspected context')
    raw = {'comparisons': []}
    for comparison in review['comparisons']:
        raw['comparisons'].append({key: comparison[key] for key in ('candidate_id', 'status', 'reason')})
        raw['comparisons'][-1]['relations'] = [
            {'relation_type': relation['relation_type'], 'rationale': relation['rationale'],
             'evidence': [{key: citation[key] for key in ('observation_id', 'utterance_id', 'quote')}
                          for citation in relation['evidence']]}
            for relation in comparison['relations']]
    checked = validate_relation_review(raw, context)
    if checked['comparisons'] != review['comparisons']:
        raise ValueError('Relation review contains altered evidence ranges or endpoints')
    leaves = [node for node in nodes if node['level'] == 1]
    if len({node['id'] for node in leaves}) != len(leaves):
        raise ValueError('Canonical node identities must be distinct')
    mapped = []
    for comparison in checked['comparisons']:
        for relation in comparison['relations']:
            endpoint_candidates = {}
            for oid in (comparison['focal_id'], comparison['candidate_id']):
                source_ids = {c['utterance_id'] for c in relation['evidence'] if c['observation_id'] == oid}
                endpoint_candidates[oid] = sorted(node['id'] for node in leaves
                    if source_ids and source_ids.issubset(node['utterance_ids']))
            origin = endpoint_candidates[comparison['focal_id']]
            destination = endpoint_candidates[comparison['candidate_id']]
            if not origin or not destination:
                disposition = 'unmapped_source'
            elif len(origin) != 1 or len(destination) != 1:
                disposition = 'ambiguous_node_ownership'
            elif origin == destination:
                disposition = 'within_node'
            else:
                disposition = 'unique_source_ownership'
            mapped.append({'focal_id': comparison['focal_id'], 'candidate_id': comparison['candidate_id'],
                'relation': relation, 'endpoint_candidates': endpoint_candidates, 'disposition': disposition,
                'from_node_id': origin[0] if disposition == 'unique_source_ownership' else None,
                'to_node_id': destination[0] if disposition == 'unique_source_ownership' else None})
    return mapped
