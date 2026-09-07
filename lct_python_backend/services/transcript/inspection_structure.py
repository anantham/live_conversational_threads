"""Conservative field relocation, never generation or semantic rewriting."""
import copy
from .source_inspection import KINDS


def normalize_structure(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('observations'), list):
        raise ValueError('Inspection structure requires regeneration')
    output, changed = copy.deepcopy(payload), []
    for index, raw in enumerate(output['observations']):
        if (isinstance(raw, dict) and isinstance(raw.get('kind'), str) and raw['kind'] in KINDS
                and isinstance(raw.get('text'), str) and raw['text'].strip()
                and isinstance(raw.get('citations'), list) and raw['citations']):
            continue
        if not isinstance(raw, dict) or len(raw) != 3 or not isinstance(raw.get('citations'), list) or not raw['citations']:
            raise ValueError('Ambiguous inspection structure requires regeneration')
        tokens = [token for key, value in raw.items() if key != 'citations' for token in (key, value)]
        if any(not isinstance(token, str) or not token.strip() for token in tokens):
            raise ValueError('Ambiguous inspection fields require regeneration')
        kinds = [token for token in tokens if token in KINDS]
        texts = [token for token in tokens if token not in KINDS | {'kind', 'text', 'citations'}]
        if len(kinds) != 1 or len(texts) != 1:
            raise ValueError('Ambiguous inspection fields require regeneration')
        output['observations'][index] = {'kind': kinds[0], 'text': texts[0], 'citations': raw['citations']}
        changed.append(index)
    return output, changed
