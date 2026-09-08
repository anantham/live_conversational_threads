"""Exact request-local observation IDs, never fuzzy repair of model output."""
import copy

ID_FIELDS = {'candidate_id', 'observation_id', 'from_observation_id', 'to_observation_id'}


def encode_observation_ids(context):
    request = copy.deepcopy(context)
    observations = [request['focal'], *request['candidates']]
    originals = [row['id'] for row in observations]
    if any(not isinstance(value, str) or not value for value in originals) or len(set(originals)) != len(originals):
        raise ValueError('Observation identities must be distinct nonempty strings')
    mapping = {}
    for index, observation in enumerate(observations):
        alias = f'o{index}'
        mapping[alias] = observation['id']
        observation['id'] = alias
    return request, mapping


def decode_observation_ids(response, mapping):
    """Translate only declared identity fields; quotes and source IDs are untouched."""
    def visit(value):
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key in ID_FIELDS:
                    if not isinstance(item, str) or item not in mapping:
                        raise ValueError('Relation review references an unknown request-local observation ID')
                    result[key] = mapping[item]
                else:
                    result[key] = visit(item)
            return result
        return value
    return visit(response)
