"""Checkpoint every bounded membership review without creating final parents."""
import asyncio
import copy
import json
import uuid

from sqlalchemy import select

from lct_python_backend.models import PipelineArtifact
from .abstraction_proposals import build_proposal_request, validate_proposals
from .aggregation_checkpoint import capture_aggregation
from .membership_review import plan_membership_reviews, validate_membership_review
from .passage_journal import JournalConflict, _hash
from .source_inspection_runner import check_inference_consent


class MembershipReviewRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope):
        self.sessions = session_factory
        self.scope = {'conversation_id': conversation_id, 'owner_id': owner_id}
        self.envelope = envelope

    async def _capture(self, db, level, *, lock=False):
        await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
        return await capture_aggregation(db, **self.scope, target_level=level, lock=lock)

    async def _checkpoint(self, db, snapshot, request, index, payload=None):
        level = snapshot['request']['target_level']
        current = await self._capture(db, level, lock=True)
        if current != snapshot:
            raise JournalConflict('Membership source or child interpretation changed')
        cid = uuid.UUID(self.scope['conversation_id'])
        stage = f'conversation_membership_review_l{level}_v1'
        rows = (await db.execute(select(PipelineArtifact).where(
            PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == stage,
            PipelineArtifact.stage_index == index))).scalars().all()
        if len(rows) > 1:
            raise JournalConflict('Multiple membership review receipts require reconciliation')
        identity = {'input_hash': snapshot['input_hash'], 'request': request,
                    'policy_fingerprint': self.envelope.fingerprint}
        if rows:
            saved = rows[0].artifact_json
            if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
                raise JournalConflict('Saved membership review requires explicit reconciliation')
            return copy.deepcopy(saved)
        if payload is None:
            return None
        result = validate_membership_review(payload, request)
        receipt = {**copy.deepcopy(identity), 'result': result}
        db.add(PipelineArtifact(conversation_id=cid, stage=stage, stage_index=index,
            artifact_type='abstraction_membership_review', artifact_json=receipt, content_hash=_hash(receipt)))
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
