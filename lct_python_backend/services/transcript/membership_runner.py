"""Checkpoint every bounded membership review without creating final parents."""
import asyncio
import copy
import json
import uuid

from sqlalchemy import select

from lct_python_backend.models import PipelineArtifact
from .abstraction_proposals import build_proposal_request, validate_proposals
from .aggregation_checkpoint import capture_aggregation, commit_aggregation
from .membership_review import plan_membership_reviews, validate_membership_review
from .membership_decision import DECISION_PROMPT, build_decision_request, validate_decision
from .parent_synthesis import PARENT_PROMPT, build_parent_request, validate_parent
from .passage_journal import JournalConflict, _hash
from .source_inspection_runner import check_inference_consent


class MembershipReviewRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope, generation=0):
        if type(generation) is not int or generation < 0:
            raise ValueError('Membership generation must be a nonnegative integer')
        self.generation = generation
        self.sessions = session_factory
        self.scope = {'conversation_id': conversation_id, 'owner_id': owner_id}
        self.envelope = envelope
        self.decision_envelope = envelope.with_system_prompt(DECISION_PROMPT)
        self.parent_envelope = envelope.with_system_prompt(PARENT_PROMPT)

    async def _capture(self, db, level, *, lock=False):
        await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
        return await capture_aggregation(db, **self.scope, target_level=level, lock=lock)

    async def _checkpoint(self, db, snapshot, request, index, payload=None, *, decision=False, parent=False):
        level = snapshot['request']['target_level']
        current = await self._capture(db, level, lock=True)
        if current != snapshot:
            raise JournalConflict('Membership source or child interpretation changed')
        cid = uuid.UUID(self.scope['conversation_id'])
        kind = 'parent' if parent else ('decision' if decision else 'review')
        stage = f'conversation_membership_{kind}_l{level}_v1'
        if self.generation:
            stage += f'_revision{self.generation}'
        rows = (await db.execute(select(PipelineArtifact).where(
            PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == stage,
            PipelineArtifact.stage_index == index))).scalars().all()
        if len(rows) > 1:
            raise JournalConflict('Multiple membership review receipts require reconciliation')
        identity = {'input_hash': snapshot['input_hash'], 'request': request,
                    'policy_fingerprint': (self.parent_envelope if parent else
                        (self.decision_envelope if decision else self.envelope)).fingerprint}
        if rows:
            saved = rows[0].artifact_json
            if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
                raise JournalConflict('Saved membership review requires explicit reconciliation')
            return copy.deepcopy(saved)
        if payload is None:
            return None
        result = (validate_parent if parent else (validate_decision if decision else validate_membership_review))(payload, request)
        receipt = {**copy.deepcopy(identity), 'result': result}
        db.add(PipelineArtifact(conversation_id=cid, stage=stage, stage_index=index,
            artifact_type=f'abstraction_membership_{kind}', artifact_json=receipt, content_hash=_hash(receipt)))
        await db.flush()
        return receipt

    async def run(self, groups, *, target_level):
        async with self.sessions.begin() as db:
            snapshot = await self._capture(db, target_level)
        children = [{**c, 'semantic_level': target_level - 1} for c in snapshot['request']['children']]
        source_map = {s['id']: s for s in snapshot['request']['sources']}
        overview = build_proposal_request(children, target_level=target_level,
            source_snapshot_hash=_hash(snapshot['request']['sources']), envelope=self.envelope)
        proposals = validate_proposals(groups, overview)
        by_id = {c['id']: c for c in children}
        requests = []
        for proposal in proposals:
            for identity in proposal['children_ids']:
                requests.extend(plan_membership_reviews(proposal, by_id[identity], source_map, envelope=self.envelope))
        receipts = []
        for index, request in enumerate(requests):
            async with self.sessions.begin() as db:
                saved = await self._checkpoint(db, snapshot, request, index)
            if saved is None:
                prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
                result = await asyncio.to_thread(self.envelope.complete_json, prompt)
                async with self.sessions.begin() as db:
                    saved = await self._checkpoint(db, snapshot, request, index, result.data)
            receipts.append(saved)
        return {'input_hash': snapshot['input_hash'], 'proposals': proposals, 'receipts': receipts,
                'status': 'proposal_reconciliation_required'}

    async def run_decisions(self, groups, *, target_level):
        reviews = await self.run(groups, target_level=target_level)
        async with self.sessions.begin() as db:
            snapshot = await self._capture(db, target_level)
        if snapshot['input_hash'] != reviews['input_hash']:
            raise JournalConflict('Source changed between review and decision')
        children = {c['id']: {**c, 'semantic_level': target_level - 1}
                    for c in snapshot['request']['children']}
        sources = {s['id']: s for s in snapshot['request']['sources']}
        by_request = {_hash(r['request']): r for r in reviews['receipts']}
        decisions = []
        for proposal in reviews['proposals']:
            for identity in proposal['children_ids']:
                expected = plan_membership_reviews(proposal, children[identity], sources, envelope=self.envelope)
                receipts = [by_request[_hash(r)] for r in expected]
                request = build_decision_request(expected, receipts, envelope=self.decision_envelope)
                index = len(decisions)
                async with self.sessions.begin() as db:
                    saved = await self._checkpoint(db, snapshot, request, index, decision=True)
                if saved is None:
                    prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
                    result = await asyncio.to_thread(self.decision_envelope.complete_json, prompt)
                    async with self.sessions.begin() as db:
                        saved = await self._checkpoint(db, snapshot, request, index, result.data, decision=True)
                decisions.append(saved)
        return {**reviews, 'decisions': decisions, 'status': 'parent_synthesis_required'
                if all(r['result']['decision'] == 'accept' for r in decisions) else 'proposal_revision_required'}

    async def run_synthesis(self, groups, *, target_level):
        decisions = await self.run_decisions(groups, target_level=target_level)
        if decisions['status'] != 'parent_synthesis_required':
            return decisions
        async with self.sessions.begin() as db:
            snapshot = await self._capture(db, target_level)
        if snapshot['input_hash'] != decisions['input_hash']:
            raise JournalConflict('Source changed between decision and parent synthesis')
        parents = []
        for index, proposal in enumerate(decisions['proposals']):
            request = build_parent_request(proposal, snapshot['request']['children'],
                [d['result'] for d in decisions['decisions']], envelope=self.parent_envelope)
            async with self.sessions.begin() as db:
                saved = await self._checkpoint(db, snapshot, request, index, parent=True)
            if saved is None:
                prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
                result = await asyncio.to_thread(self.parent_envelope.complete_json, prompt)
                async with self.sessions.begin() as db:
                    saved = await self._checkpoint(db, snapshot, request, index, result.data, parent=True)
            parents.append(saved)
        policy = _hash({'review': self.envelope.fingerprint, 'decision': self.decision_envelope.fingerprint,
                        'synthesis': self.parent_envelope.fingerprint, 'proposals': decisions['proposals']})
        async with self.sessions.begin() as db:
            await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
            tier = await commit_aggregation(db, **self.scope, snapshot=snapshot,
                payload={'nodes': [p['result'] for p in parents]}, policy_fingerprint=policy)
        return {**decisions, 'parents': parents, 'tier': tier, 'status': 'tier_committed'}
