"""Reversible child identifiers for proposal inference, never canonical storage."""
import copy
import re

REFERENCE = re.compile(r'(?<![\w@])@child_*\d+(?![\w])')


def pack_proposal(request):
    identities = [child['id'] for child in request['children']]
    if any(not isinstance(identity, str) or not identity for identity in identities):
        raise ValueError('Proposal child identities must be nonempty strings')
    if len(set(identities)) != len(identities):
        raise ValueError('Duplicate proposal child identity')
    # Avoid collisions with existing values, including source text that happens
    # to be exactly an alias. Free text is never substring-replaced.
    def strings(value):
        if isinstance(value, str): yield value
        elif isinstance(value, dict):
            yield from value.keys()
            for item in value.values(): yield from strings(item)
        elif isinstance(value, list):
            for item in value: yield from strings(item)
    occupied = set(strings(request))
    occupied.update(token for value in tuple(occupied) if isinstance(value, str)
                    for token in REFERENCE.findall(value))
    prefix = '@child'
    while any(f'{prefix}{index}' in occupied for index in range(len(identities))):
        prefix += '_'
    forward = {identity: f'{prefix}{index}' for index, identity in enumerate(identities)}
    reference_fields = {'id', 'node_id', 'child_id', 'children_ids', 'occurrence_ids', 'pair'}
    def replace(value, field=None):
        if isinstance(value, str): return forward.get(value, value) if field in reference_fields else value
        if isinstance(value, dict): return {forward.get(key, key): replace(item, key) for key, item in value.items()}
        if isinstance(value, list): return [replace(item, field) for item in value]
        return copy.deepcopy(value)
    return replace(request), {alias: identity for identity, alias in forward.items()}


def unpack_proposal(payload, aliases):
    result = copy.deepcopy(payload)
    if not isinstance(result, dict) or not isinstance(result.get('groups'), list):
        raise ValueError('Expected proposal groups')
    for group in result['groups']:
        if not isinstance(group, dict) or not isinstance(group.get('children_ids'), list):
            raise ValueError('Expected proposal child selections')
        ids = group['children_ids']
        if any(not isinstance(value, str) or value not in aliases for value in ids):
            raise ValueError('Unknown proposal child reference')
        group['children_ids'] = [aliases[value] for value in ids]
        for field in ('label', 'rationale'):
            if isinstance(group.get(field), str):
                def restore(match):
                    if match[0] not in aliases:
                        raise ValueError('Unknown proposal reference in narrative')
                    return aliases[match[0]]
                group[field] = REFERENCE.sub(restore, group[field])
    return result
