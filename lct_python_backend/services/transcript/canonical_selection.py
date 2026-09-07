"""Source-overlap candidates and explicit semantic endpoint adjudication."""
import copy


def canonical_candidates(observation, nodes):
    sources = {s['utterance_id'] for s in observation['source_excerpts']}
    return [{key: copy.deepcopy(node.get(key)) for key in
             ('id', 'level', 'node_name', 'summary', 'utterance_ids')}
            for node in sorted(nodes, key=lambda n: n['id'])
            if node['level'] == 1 and sources.intersection(node['utterance_ids'])]


def validate_node_selections(relation, endpoints):
    if not any('canonical_candidates' in obs for obs in endpoints.values()):
        return None  # Legacy source-only diagnostic contexts remain readable.
    rows = relation.get('node_selections')
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError('Canonical mapping requires two explicit node selections or abstentions')
    selected = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'observation_id', 'node_id', 'rationale'}:
            raise ValueError('Invalid canonical node selection fields')
        oid, nid = row['observation_id'], row['node_id']
        if (not isinstance(oid, str) or oid not in endpoints or oid in selected
                or not isinstance(row['rationale'], str) or not row['rationale'].strip()):
            raise ValueError('Invalid canonical node selection identity or rationale')
        options = {n['id']: n for n in endpoints[oid].get('canonical_candidates', [])}
        if nid is not None:
            if not isinstance(nid, str) or nid not in options:
                raise ValueError('Canonical node selection is not an admitted candidate')
            cited = {c['utterance_id'] for c in relation['evidence'] if c['observation_id'] == oid}
            if not cited.issubset(options[nid]['utterance_ids']):
                raise ValueError('Canonical node selection does not own all cited source')
        selected[oid] = copy.deepcopy(row)
    return [selected[oid] for oid in sorted(selected)]
