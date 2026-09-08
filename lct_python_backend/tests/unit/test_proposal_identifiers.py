"""Test intent: lossless references, collision safety, unknown output rejection.

Canonical requests and all narrative strings remain unchanged in storage.
"""
import copy
import pytest
from lct_python_backend.services.transcript.proposal_identifiers import pack_proposal, unpack_proposal


def test_roundtrip_selections_and_repeated_references():
    request={'children':[{'id':'uuid-a','summary':'Mention uuid-a in prose.'}, {'id':'uuid-b'}],
             'evidence':[{'node_id':'uuid-a','quote':'A full quotation.'}]}
    before=copy.deepcopy(request)
    packed, aliases=pack_proposal(request)
    assert request==before
    assert packed['children'][0]['summary']==request['children'][0]['summary']
    assert packed['evidence'][0]['node_id']==packed['children'][0]['id']
    payload={'groups':[{'label':'Inquiry','rationale':'Uncertain.',
                        'children_ids':[child['id'] for child in packed['children']]}]}
    assert unpack_proposal(payload, aliases)['groups'][0]['children_ids']==['uuid-a','uuid-b']


def test_collision_avoided_and_unknown_selection_rejected():
    packed, aliases=pack_proposal({'children':[{'id':'a','summary':'@child0'}]})
    assert packed['children'][0]['id']!='@child0'
    assert packed['children'][0]['summary']=='@child0'
    with pytest.raises(ValueError):
        unpack_proposal({'groups':[{'children_ids':['@child0']}]}, aliases)
