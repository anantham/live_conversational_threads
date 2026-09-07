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
             'from_observation_id': relation['from_observation_id'],
             'to_observation_id': relation['to_observation_id'],
             **({'node_selections': relation['node_selections']} if 'node_selections' in relation else {}),
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
            origin = endpoint_candidates[relation['from_observation_id']]
            destination = endpoint_candidates[relation['to_observation_id']]
            if not origin or not destination:
                disposition = 'unmapped_source'
            elif len(origin) != 1 or len(destination) != 1:
                disposition = 'ambiguous_node_ownership'
            elif origin == destination:
                disposition = 'within_node'
            else:
                disposition = 'unique_source_ownership'
            if 'node_selections' in relation:
                selected = {row['observation_id']: row['node_id'] for row in relation['node_selections']}
                origin_id, destination_id = selected[relation['from_observation_id']], selected[relation['to_observation_id']]
                if origin_id is None or destination_id is None:
                    disposition = 'semantic_mapping_unresolved'
                elif origin_id not in origin or destination_id not in destination:
                    raise ValueError('Selected canonical node differs from current source ownership')
                elif origin_id == destination_id:
                    disposition = 'within_node'
                else:
                    origin, destination, disposition = [origin_id], [destination_id], 'semantic_selection'
            mapped.append({'focal_id': comparison['focal_id'], 'candidate_id': comparison['candidate_id'],
                'relation': relation, 'endpoint_candidates': endpoint_candidates, 'disposition': disposition,
                'from_node_id': origin[0] if disposition in ('unique_source_ownership', 'semantic_selection') else None,
                'to_node_id': destination[0] if disposition in ('unique_source_ownership', 'semantic_selection') else None})
    return mapped
