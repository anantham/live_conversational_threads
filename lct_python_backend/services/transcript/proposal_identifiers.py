"""Reversible child identifiers for proposal inference, never canonical storage."""
import copy


def pack_proposal(request):
    identities = [child['id'] for child in request['children']]
    if len(set(identities)) != len(identities):
        raise ValueError('Duplicate proposal child identity')
    # Avoid collisions with existing values, including source text that happens
    # to be exactly an alias. Free text is never substring-replaced.
    def strings(value):
        if isinstance(value, str): yield value
        elif isinstance(value, dict):
            for item in value.values(): yield from strings(item)
        elif isinstance(value, list):
            for item in value: yield from strings(item)
    occupied = set(strings(request))
    prefix = '@child'
    while any(f'{prefix}{index}' in occupied for index in range(len(identities))):
        prefix += '_'
    forward = {identity: f'{prefix}{index}' for index, identity in enumerate(identities)}
    def replace(value):
        if isinstance(value, str): return forward.get(value, value)
        if isinstance(value, dict): return {key: replace(item) for key, item in value.items()}
        if isinstance(value, list): return [replace(item) for item in value]
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
    return result
