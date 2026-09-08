"""Intent: relation-policy forks never silently mix old generated edges.

Projection preserves its input and unrelated edges; missing provenance, altered
receipts, unknown downstream work and existing hierarchy fail closed.
"""
import copy
import pytest
from tools.public_replay_fork import select_pre_relation_rows
from lct_python_backend.services.transcript.passage_journal import _hash


def fixture():
    old = {'id': 'old', 'from_node_id': 'a', 'to_node_id': 'b',
           'relationship_type': 'supports', 'relationship_subtype': None}
    new = {**old, 'id': 'new', 'relationship_subtype': 'reconciled:source_cited'}
    body = {'edges': [{'id': 'new', 'from_node_id': 'a', 'to_node_id': 'b',
                      'relation_type': 'supports', 'disposition': 'created'}]}
    artifact = {'id': 'review', 'artifact_type': 'source_reviewed_relations',
                'artifact_json': body, 'content_hash': _hash(body)}
    inspection = {'id': 'inspection', 'artifact_type': 'source_inspection',
                  'artifact_json': {'synthetic': True}, 'content_hash': _hash({'synthetic': True})}
    return {'nodes': [{'id': 'a', 'level': 1, 'parent_id': None, 'children_ids': []}],
            'relationships': [old, new], 'pipeline_artifacts': [inspection, artifact]}


def test_only_proven_relation_outputs_are_excluded_without_mutation():
    rows = fixture()
    before = copy.deepcopy(rows)
    projected, receipt = select_pre_relation_rows(rows)
    assert rows == before
    assert projected['nodes'] == rows['nodes']
    assert projected['relationships'] == [rows['relationships'][0]]
    assert projected['pipeline_artifacts'] == [rows['pipeline_artifacts'][0]]
    assert receipt['excluded_created_edge_ids'] == ['new']
    assert receipt['excluded_relation_artifacts'] == [
        {'id': 'review', 'content_hash': rows['pipeline_artifacts'][1]['content_hash']}]


@pytest.mark.parametrize('fault', ['digest', 'unknown_stage', 'hierarchy', 'missing_edge',
                                  'wrong_endpoint', 'wrong_type', 'unreceipted', 'disposition'])
def test_ambiguous_lineage_rejects(fault):
    rows = fixture()
    if fault == 'digest': rows['pipeline_artifacts'][1]['content_hash'] = 'wrong'
    elif fault == 'unknown_stage': rows['pipeline_artifacts'][0]['artifact_type'] = 'aggregation'
    elif fault == 'hierarchy': rows['nodes'][0]['level'] = 2
    elif fault == 'missing_edge': rows['relationships'].pop()
    elif fault == 'wrong_endpoint': rows['relationships'][1]['to_node_id'] = 'other'
    elif fault == 'wrong_type': rows['relationships'][1]['relationship_type'] = 'rebuts'
    elif fault == 'unreceipted': rows['pipeline_artifacts'].pop()
    else:
        artifact = rows['pipeline_artifacts'][1]
        artifact['artifact_json']['edges'][0]['disposition'] = 'guessed'
        artifact['content_hash'] = _hash(artifact['artifact_json'])
    with pytest.raises(ValueError):
        select_pre_relation_rows(rows)


def test_reused_non_generated_edge_is_preserved():
    rows = fixture()
    artifact = rows['pipeline_artifacts'][1]
    artifact['artifact_json']['edges'].append({'id': 'old', 'from_node_id': 'a', 'to_node_id': 'b',
        'relation_type': 'supports', 'disposition': 'existing_edges_preserved'})
    artifact['content_hash'] = _hash(artifact['artifact_json'])
    projected, _ = select_pre_relation_rows(rows)
    assert [edge['id'] for edge in projected['relationships']] == ['old']
