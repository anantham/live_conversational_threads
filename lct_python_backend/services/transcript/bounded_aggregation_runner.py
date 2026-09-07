"""Compose complete grouping proposals with durable source scrutiny and synthesis.

Uncertain/rejected memberships require proposal revision, never forced coverage.
Every inference stage uses the same owner-bound provider/consent envelope.
"""
import asyncio
import copy
import json
import uuid

from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .abstraction_proposals import PROPOSAL_PROMPT, build_proposal_request, validate_proposals
from .aggregation_checkpoint import capture_aggregation
from .membership_review import MEMBERSHIP_PROMPT
from .membership_runner import MembershipReviewRunner
from .passage_journal import JournalConflict, _hash
from .source_inspection_runner import check_inference_consent


class AbstractionNeedsRevision(ValueError):
    """A proposed membership was rejected or remains uncertain; no forced parent."""


class BoundedAggregationRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope):
        self.sessions = session_factory
        self.scope = {'conversation_id': conversation_id, 'owner_id': owner_id}
        self.envelope = envelope.with_system_prompt(PROPOSAL_PROMPT)
        self.memberships = MembershipReviewRunner(session_factory=session_factory, **self.scope,
                                                  envelope=envelope.with_system_prompt(MEMBERSHIP_PROMPT))

    async def _capture(self, db, level, *, lock=False):
        await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
        return await capture_aggregation(db, **self.scope, target_level=level, lock=lock)

    async def _proposal_checkpoint(self, db, snapshot, request, payload=None, *, generation=0):
        level = snapshot['request']['target_level']
        if await self._capture(db, level, lock=True) != snapshot:
            raise JournalConflict('Abstraction inputs changed during proposal generation')
        cid = uuid.UUID(self.scope['conversation_id'])
        stage = 'conversation_abstraction_proposal_v1'
        if generation:
            stage += f'_revision{generation}'
        rows = (await db.execute(select(PipelineArtifact).where(PipelineArtifact.conversation_id == cid,
            PipelineArtifact.stage == stage, PipelineArtifact.stage_index == level))).scalars().all()
        if len(rows) > 1:
            raise JournalConflict('Multiple abstraction proposal receipts require reconciliation')
        identity = {'input_hash': snapshot['input_hash'], 'request': request,
                    'policy_fingerprint': self.envelope.fingerprint}
        if rows:
            saved = rows[0].artifact_json
            if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
                raise JournalConflict('Saved abstraction proposal requires revision reconciliation')
            return copy.deepcopy(saved)
        if payload is None: return None
        validate_proposals(payload, request)
        receipt = {**copy.deepcopy(identity), 'groups': copy.deepcopy(payload)}
        db.add(PipelineArtifact(conversation_id=cid, stage=stage, stage_index=level,
            artifact_type='abstraction_proposal', artifact_json=receipt, content_hash=_hash(receipt)))
        await db.flush()
        return receipt

    async def run_level(self, target_level):
        async with self.sessions.begin() as db:
            snapshot = await self._capture(db, target_level)
        children = [{**c, 'semantic_level': target_level - 1} for c in snapshot['request']['children']]
        request = build_proposal_request(children, target_level=target_level,
            source_snapshot_hash=_hash(snapshot['request']['sources']), envelope=self.envelope)
        previous = None
        for generation in range(3):
            attempt = copy.deepcopy(request)
            if previous is not None:
                attempt['revision'] = {
                    'instruction': 'Revise the previous grouping using all membership feedback. '
                        'Retain uncertainty and unanswered questions. Do not force acceptance. '
                        'You may split groups or revise their scope; cover every child.',
                    'previous_groups': previous['proposals'],
                    'membership_feedback': [d['result'] for d in previous['decisions']]}
            prompt = json.dumps(attempt, ensure_ascii=False, separators=(',', ':'))
            self.envelope.validate(prompt)
            async with self.sessions.begin() as db:
                saved = await self._proposal_checkpoint(db, snapshot, attempt, generation=generation)
            if saved is None:
                result = await asyncio.to_thread(self.envelope.complete_json, prompt)
                async with self.sessions.begin() as db:
                    saved = await self._proposal_checkpoint(db, snapshot, attempt, result.data, generation=generation)
            runner = self.memberships if generation == 0 else MembershipReviewRunner(
                session_factory=self.sessions, **self.scope,
                envelope=self.memberships.envelope, generation=generation)
            previous = await runner.run_synthesis(saved['groups'], target_level=target_level)
            if previous['status'] == 'tier_committed':
                return previous['tier']
        raise AbstractionNeedsRevision(
            f'Abstraction tier {target_level} remains unsupported after 3 audited proposal attempts')

    async def run_through(self, highest_level=5):
        if type(highest_level) is not int or highest_level not in {2, 3, 4, 5}:
            raise ValueError('Highest abstraction tier must be between 2 and 5')
        return [await self.run_level(level) for level in range(2, highest_level + 1)]
