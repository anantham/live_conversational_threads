"""Intent: annotation changes during synthesis or at final commit block parents.

Real PostgreSQL receipts and canonical graph writes, synthetic model responses.
Recovery under another annotation basis cannot silently reuse old judgments.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance, Node, PipelineArtifact
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.membership_review import MEMBERSHIP_PROMPT
from lct_python_backend.services.transcript.membership_runner import MembershipReviewRunner
from lct_python_backend.services.transcript.passage_journal import JournalConflict


@pytest.mark.asyncio
@pytest.mark.parametrize('change_at',['parent_generation','final_commit','recovery'])
async def test_annotation_revision_guards_parent_write_and_recovery(monkeypatch,change_at):
    url=os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url: pytest.skip('Explicit isolated database required')
    parsed=urlparse(url)
    assert parsed.hostname in {'127.0.0.1','localhost'} and parsed.port==55439
    engine=create_async_engine(url); sessions=async_sessionmaker(engine,expire_on_commit=False)
    cid,uid,nid=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
    owner=f'synthetic-annotation-membership-{cid}'; revision=['first']; calls=[]
    async def guard(db):
        if change_at=='final_commit':
            parent=(await db.execute(select(PipelineArtifact.id).where(
                PipelineArtifact.conversation_id==cid,
                PipelineArtifact.artifact_type=='abstraction_membership_parent'))).scalars().all()
            if parent: revision[0]='changed'
        if revision[0]!='first': raise JournalConflict('Annotation basis changed')
    def transport(**kwargs):
        request=json.loads(kwargs['messages'][1]['content']); calls.append(request)
        if 'source_page' in request:
            ids=[s['span_id'] for s in request['source_page']['spans']]
            return SimpleNamespace(data={'reviewed_span_ids':ids,'judgment':'supports',
                'rationale':'The source asks about borrowing.','evidence_span_ids':ids})
        if 'reviews' in request:
            return SimpleNamespace(data={'decision':'accept','rationale':'Source supports inquiry.',
                'qualifications':'Unresolved','reviewed_ids':[r['review_id'] for r in request['reviews']],
                'evidence_ids':[e['evidence_id'] for r in request['reviews'] for e in r['evidence']]})
        if change_at=='parent_generation': revision[0]='changed'
        return SimpleNamespace(data={'node_name':'Borrowing inquiry','summary':'Who may borrow the key?',
            'memberships':[{'child_id':m['child']['id'],'evidence_ids':[m['evidence'][0]['evidence_id']]}
                           for m in request['members']]})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync',transport)
    envelope=InferenceEnvelope(system_prompt=MEMBERSHIP_PROMPT,
        providers=[{'id':'local','model':'synthetic','trust_scope':'owner_private','context_tokens':20000}],
        privacy={'local_llm_ok':True},output_tokens=512,headroom_tokens=128)
    options=dict(session_factory=sessions,conversation_id=str(cid),owner_id=owner,envelope=envelope,
                 revision_guard=guard,revision_identity={'annotation_hash':'first'})
    groups={'groups':[{'label':'Borrowing','rationale':'An open inquiry.','children_ids':[str(nid)]}]}
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid,owner_id=owner,conversation_name='Synthetic revision',
                conversation_type='transcript',source_type='synthetic',started_at=datetime.now(timezone.utc),
                source_metadata={'privacy':{'local_llm_ok':True,'external_llm_ok':False}}))
            await db.flush()
            db.add(Utterance(id=uid,conversation_id=cid,sequence_number=1,text='Who may borrow the key?',speaker_id='S0'))
            await db.flush()
            await persist_graph(db=db,conversation_id=str(cid),owner_id=owner,append_only=True,commit=False,
                existing_json=[{'id':str(nid),'semantic_level':1,'node_name':'Key','summary':'Who may borrow?',
                                'thread_id':'original-key','utterance_ids':[str(uid)]}])
        runner=MembershipReviewRunner(**options)
        if change_at=='recovery':
            first=await runner.run_synthesis(groups,target_level=2)
            before=len(calls)
            options['revision_identity']={'annotation_hash':'second'}
            with pytest.raises(JournalConflict): await MembershipReviewRunner(**options).run_synthesis(groups,target_level=2)
            assert len(calls)==before
            assert first['tier']['nodes']
        else:
            with pytest.raises(JournalConflict,match='Annotation basis'): await runner.run_synthesis(groups,target_level=2)
            async with sessions() as db:
                assert (await db.execute(select(Node.id).where(Node.conversation_id==cid))).scalars().all()==[nid]
                assert not (await db.execute(select(PipelineArtifact.id).where(
                    PipelineArtifact.conversation_id==cid,PipelineArtifact.artifact_type=='source_backed_abstraction'))).scalars().all()
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id==cid,Conversation.owner_id==owner))
        await engine.dispose()
