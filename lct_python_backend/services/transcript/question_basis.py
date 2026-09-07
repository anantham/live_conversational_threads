"""Question-local revision identity; unrelated conversation growth is not drift.

Retain every passage/source field and contributing canonical node, not just
quoted strings. This identity is for custody/recovery, never semantic truth.
"""
import copy
from .question_memory import fold_question_memory


def question_basis(basis, question_id):
    state = basis['state']
    memory = fold_question_memory(state['nodes'], state['chunks'])
    if question_id not in memory:
        raise ValueError('Question is unavailable in captured revision')
    question = memory[question_id]
    events = [question['original'], *question['intermediate'], question['latest']]
    node_ids = {event['node_id'] for event in events}
    chunk_ids = {event['chunk_id'] for event in events}
    mapping = {cid: state['utterance_chunk_map'][cid] for cid in sorted(chunk_ids)}
    source_ids = {uid for ids in mapping.values() for uid in ids}
    sources = [row for row in basis['source']['request']['sources'] if row['id'] in source_ids]
    if len(sources) != len(source_ids) or {row['id'] for row in sources} != source_ids:
        raise ValueError('Question source identities are missing or duplicated')
    return copy.deepcopy({'question_id': question_id,
        'nodes': [node for node in state['nodes'] if node['id'] in node_ids],
        'chunks': {cid: state['chunks'][cid] for cid in sorted(chunk_ids)},
        'utterance_chunk_map': mapping, 'sources': sources})
