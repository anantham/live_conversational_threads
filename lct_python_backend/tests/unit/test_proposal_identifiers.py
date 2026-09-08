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

def test_narrative_references_restored_without_prefix_confusion():
    aliases={'@child1':'one','@child10':'ten'}
    payload={'groups':[{'children_ids':['@child1'], 'label':'Example',
                        'rationale':'@child10 relates to @child1.'}]}
    assert unpack_proposal(payload,aliases)['groups'][0]['rationale']=='ten relates to one.'
    payload['groups'][0]['rationale']='@child99 is invented'
    with pytest.raises(ValueError): unpack_proposal(payload,aliases)

def test_keys_and_collision_tokens_but_not_quotations_are_transformed():
    request={'children':[{'id':'a','summary':'a'}], 'by_node':{'a':{'node_id':'a'}},
             'quote':'The literal @child0 is mentioned.'}
    packed,_=pack_proposal(request)
    alias=packed['children'][0]['id']
    assert alias!='@child0'
    assert packed['children'][0]['summary']=='a'
    assert packed['quote']==request['quote']
    assert packed['by_node']=={alias:{'node_id':alias}}

def test_nonstring_id_rejected_before_inference():
    with pytest.raises(ValueError): pack_proposal({'children':[{'id':1}]})
