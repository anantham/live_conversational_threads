"""Test intent: actual proposal prompts consume current explicitly selected
identity annotations without ID rewrites or forced memberships. Full annotation
judgments and citations are budgeted without duplicating audit transcripts;
a source/annotation revision during generation cannot save a
proposal receipt. Storage/source capture and membership synthesis are doubled.
Zero selected candidates remain explicitly not reviewed, not a reason to use
another policy or to prevent source-based grouping.
"""
import copy
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from lct_python_backend.services.transcript.bounded_aggregation_runner import BoundedAggregationRunner
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded
from lct_python_backend.services.transcript.passage_journal import JournalConflict


def make_runner(monkeypatch, *, capacity=15000, change=None, enabled=True):
    from lct_python_backend.services.transcript import bounded_aggregation_runner as module
    snapshot={'input_hash':'source-revision-1','request':{'target_level':2,'sources':[],
        'children':[{'id':'a','node_name':'Key question','summary':'Who may borrow?', 'thread_id':'key'},
                    {'id':'b','node_name':'Key callback','summary':'May guests borrow?', 'thread_id':'guests'}]}}
    annotations={'schema_version':1,'verification':'model_reviewed_not_human_verified',
        'possible_pair_count':1,'policies':[{'policy_fingerprint':'chosen','coverage_complete':True,
        'annotations':[{'judgment':'same_inquiry','pair':['a','b'],'policy_fingerprint':'chosen',
                        'sources':[{'text':'Full unabridged evidence.'}]}]}]}
    stored=[]; prompts=[]
    class DB:
        async def execute(self, statement):
            return SimpleNamespace(scalars=lambda:SimpleNamespace(all=lambda:list(stored)))
        def add(self, artifact): stored.append(artifact)
        async def flush(self): pass
    @asynccontextmanager
    async def begin(): yield DB()
    async def capture(*args,**kwargs): return copy.deepcopy(snapshot)
    async def consent(*args,**kwargs): pass
    async def loader(db): return copy.deepcopy(annotations)
    monkeypatch.setattr(module,'capture_aggregation',capture)
    monkeypatch.setattr(module,'check_inference_consent',consent)
    def generate(**kwargs):
        prompts.append(json.loads(kwargs['messages'][1]['content']))
        if change: change(snapshot,annotations)
        return SimpleNamespace(data={'groups':[{'label':'Key access','rationale':'Shared inquiry',
                                                'children_ids':['a','b']}]})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync',generate)
    env=InferenceEnvelope(system_prompt='unused',providers=[{'id':'local','model':'synthetic',
        'enabled':True,'trust_scope':'owner_private','base_url':'http://127.0.0.1:11434',
        'context_tokens':capacity}],privacy={'local_llm_ok':True,'external_llm_ok':False},
        output_tokens=100,headroom_tokens=50)
    runner=BoundedAggregationRunner(session_factory=SimpleNamespace(begin=begin),
        conversation_id='00000000-0000-0000-0000-000000000001',owner_id='synthetic',envelope=env,
        **({'identity_review_loader':loader,'identity_policy_fingerprint':'chosen'} if enabled else {}))
    async def synthesis(self,groups,**kwargs):
        return {'status':'tier_committed','tier':groups}
    monkeypatch.setattr(module.MembershipReviewRunner,'run_synthesis',synthesis)
    return runner,snapshot,annotations,stored,prompts


@pytest.mark.asyncio
async def test_actual_proposal_consumes_selected_review_without_rewriting_ids(monkeypatch):
    runner,snapshot,annotations,stored,prompts=make_runner(monkeypatch)
    annotations['policies'].append({'policy_fingerprint':'other','annotations':[{'judgment':'related_distinct'}]})
    before=copy.deepcopy(snapshot)
    await runner.run_level(2)
    assert [c['thread_id'] for c in prompts[0]['children']]==['key','guests']
    context=prompts[0]['thread_identity_reviews']
    assert context['policy_fingerprint']=='chosen'
    assert context['annotations'][0]['judgment']=='same_inquiry'
    assert 'sources' not in context['annotations'][0]
    assert context['annotations'][0]['source_bodies_included'] is False
    assert annotations['policies'][0]['annotations'][0]['sources']==[{'text':'Full unabridged evidence.'}]
    assert snapshot==before and len(stored)==1


@pytest.mark.asyncio
@pytest.mark.parametrize('kind',['source','annotation'])
async def test_revision_during_generation_cannot_save_receipt(monkeypatch,kind):
    def change(snapshot,annotations):
        if kind=='source': snapshot['input_hash']='revised'
        else: annotations['policies'][0]['annotations'][0]['judgment']='uncertain'
    runner,_,_,stored,_=make_runner(monkeypatch,change=change)
    with pytest.raises(JournalConflict): await runner.run_level(2)
    assert stored==[]


@pytest.mark.asyncio
async def test_full_annotations_must_fit_and_missing_policy_stays_explicitly_unreviewed(monkeypatch):
    runner,_,annotations,stored,prompts=make_runner(monkeypatch)
    annotations['policies'][0]['annotations'][0]['rationale']='qualification '*10000
    with pytest.raises(ContextBudgetExceeded): await runner.run_level(2)
    assert stored==[] and prompts==[]
    annotations['policies'][0]['policy_fingerprint']='different'
    await runner.run_level(2)
    assert prompts[0]['thread_identity_reviews']=={
        'policy_fingerprint':'chosen','annotations':[],'coverage_complete':False,
        'reviewed_pair_count':0,'possible_pair_count':1,'status':'not_reviewed'}


@pytest.mark.asyncio
async def test_unconfigured_legacy_request_unchanged(monkeypatch):
    runner,_,_,stored,prompts=make_runner(monkeypatch,enabled=False)
    await runner.run_level(2)
    assert 'thread_identity_reviews' not in prompts[0]
    assert len(stored)==1

@pytest.mark.asyncio
async def test_large_audit_sources_do_not_duplicate_into_proposal(monkeypatch):
    runner,_,annotations,_,prompts=make_runner(monkeypatch)
    review=annotations['policies'][0]['annotations'][0]
    review['sources'][0]['text']='evidence '*100000
    review['rationale']='Related, not equivalent.'
    review['evidence']=[{'quote':'evidence','node_id':'a','source_id':'s'}]
    before=copy.deepcopy(review)
    await runner.run_level(2)
    projection=prompts[0]['thread_identity_reviews']['annotations'][0]
    assert projection['rationale']==before['rationale']
    assert projection['evidence']==before['evidence']
    assert review==before
    assert len(json.dumps(projection)) < 1000
