"""End-to-end internal source inspection, candidate review and canonical edges.

All stages use one conversation/owner and current stored consent. Saved batches
recover without embedding or generation. Production entry points remain opt-in;
question identity reconciliation and bounded abstraction are still separate work.
"""
import copy
import json
import uuid

from sqlalchemy import select

from lct_python_backend.models import PipelineArtifact
from .inspection_context import inspection_index, plan_inspection_context
from .inspection_relations import review_inspection_context
from .passage_journal import JournalConflict, _hash
from .reconciliation_checkpoint import STAGE, capture_reconciliation, checkpoint_relation_review
from .source_inspection_runner import SourceInspectionRunner, check_inference_consent


class ReconciliationRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, inspection_envelope,
                 review_envelope, retriever, max_candidates=8, excerpt_characters=400):
        if (type(max_candidates) is not int or max_candidates < 1
                or type(excerpt_characters) is not int or excerpt_characters < 0):
            raise ValueError('Valid reconciliation candidate and excerpt budgets are required')
        self.sessions, self.cid, self.owner = session_factory, conversation_id, owner_id
        self.inspection = SourceInspectionRunner(session_factory=session_factory,
            conversation_id=conversation_id, owner_id=owner_id, envelope=inspection_envelope)
        self.envelope, self.retriever = review_envelope, retriever
        self.max_candidates, self.excerpt_characters = max_candidates, excerpt_characters
        self.providers = [*review_envelope.providers, *retriever.providers]
        self.fingerprint = _hash({'version': 1, 'generation': review_envelope.fingerprint,
            'inspection': inspection_envelope.fingerprint, 'retrieval': retriever.fingerprint,
            'max_candidates': max_candidates, 'excerpt_characters': excerpt_characters})

    async def run(self):
        scope = {'conversation_id': self.cid, 'owner_id': self.owner}
        # Check every eventual recipient before starting a potentially long scan.
        async with self.sessions.begin() as db:
            await check_inference_consent(db, **scope, providers=self.providers)
        inspection = await self.inspection.run()
        async with self.sessions.begin() as db:
            await check_inference_consent(db, **scope, providers=self.providers)
            snapshot = await capture_reconciliation(db, **scope)
        source = snapshot['source_snapshot']
        if source['input_hash'] != inspection['input_hash']:
            raise JournalConflict('Source changed between inspection and relation review')
        index = inspection_index(source, inspection['receipts'])
        watermark = max(row['sequence_number'] for row in source['request']['sources'])
        receipts = []
        for batch, focal_id in enumerate(index['observations']):
            args = {**scope, 'snapshot': snapshot, 'batch_index': batch,
                    'policy_fingerprint': self.fingerprint, 'providers': self.providers}
            async with self.sessions.begin() as db:
                await check_inference_consent(db, **scope, providers=self.providers)
                rows = (await db.execute(select(PipelineArtifact).where(
                    PipelineArtifact.conversation_id == uuid.UUID(self.cid),
                    PipelineArtifact.stage == STAGE, PipelineArtifact.stage_index == batch))).scalars().all()
                if len(rows) > 1:
                    raise JournalConflict('Multiple relation receipts at one batch index')
                if rows:
                    context = copy.deepcopy(rows[0].artifact_json['context'])
                    if context['focal']['id'] != focal_id:
                        raise JournalConflict('Saved relation batch no longer matches this observation')
                    saved = await checkpoint_relation_review(db, **args, context=context)
                else:
                    saved = None
            if saved is None:
                prompt = await plan_inspection_context(source, inspection['receipts'], focal_id=focal_id,
                    available_through_sequence=watermark, envelope=self.envelope, retriever=self.retriever,
                    max_candidates=self.max_candidates, excerpt_characters=self.excerpt_characters)
                context = json.loads(prompt)
                async with self.sessions.begin() as db:
                    saved = await checkpoint_relation_review(db, **args, context=context)
                if saved is None:
                    review = await review_inspection_context(prompt, envelope=self.envelope)
                    review['generation_policy_fingerprint'] = review['policy_fingerprint']
                    review['policy_fingerprint'] = self.fingerprint
                    async with self.sessions.begin() as db:
                        saved = await checkpoint_relation_review(db, **args, context=context, review=review)
            receipts.append(saved)
        return {'source_hash': source['input_hash'], 'receipts': receipts,
                'review_pass_complete': True,
                'unresolved_mappings': sum(p['disposition'] != 'unique_source_ownership'
                    for receipt in receipts for p in receipt['mapping']),
                'abstained_inspection_pages': inspection['abstained_pages'],
                'semantic_reconciliation_complete': False}
