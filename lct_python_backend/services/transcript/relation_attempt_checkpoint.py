"""Immutable partial comparison receipts; no canonical edges before coverage."""
import copy
import uuid
from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .inspection_relations import validate_relation_review
from .passage_journal import JournalConflict, _hash
from .reconciliation_checkpoint import capture_reconciliation, validate_context_source
from .source_inspection_runner import check_inference_consent


async def checkpoint_relation_attempt(db, *, conversation_id, owner_id, snapshot,
                                      parent_context, context, attempt, policy_fingerprint,
                                      providers, response=None):
    if type(attempt) is not int or not 0 <= attempt < 3:
        raise ValueError('Relation attempt must be within the three-request budget')
    scope = dict(conversation_id=conversation_id, owner_id=owner_id)
    await check_inference_consent(db, **scope, providers=providers)
    if await capture_reconciliation(db, **scope, lock=True) != snapshot:
        raise JournalConflict('Source or interpretation changed during partial relation review')
    validate_context_source(context, snapshot)
    candidates = {row['id']: row for row in parent_context['candidates']}
    if (context['focal'] != parent_context['focal']
            or any(row != candidates.get(row['id']) for row in context['candidates'])
            or len({row['id'] for row in context['candidates']}) != len(context['candidates'])):
        raise JournalConflict('Partial relation request differs from its admitted evidence')
    identity = {'basis_hash': snapshot['basis_hash'], 'parent_context_hash': _hash(parent_context),
                'policy_fingerprint': policy_fingerprint}
    stage = 'relpart_v1_' + _hash(identity)[:39]
    identity['context_hash'] = _hash(context)
    cid = uuid.UUID(conversation_id)
    rows = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == stage,
        PipelineArtifact.stage_index == attempt))).scalars().all()
    if len(rows) > 1:
        raise JournalConflict('Multiple partial relation receipts at one attempt')
    if rows:
        saved = rows[0].artifact_json
        if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
            raise JournalConflict('Partial relation receipt identity or content differs')
        validate_relation_review(saved['response'], context, allow_partial=True)
        return copy.deepcopy(saved['response'])
    if response is None:
        return None
    validate_relation_review(response, context, allow_partial=True)
    saved = {**identity, 'context': copy.deepcopy(context), 'response': copy.deepcopy(response)}
    db.add(PipelineArtifact(conversation_id=cid, stage=stage, stage_index=attempt,
        artifact_type='partial_relation_review', artifact_json=saved, content_hash=_hash(saved)))
    await db.flush()
    return copy.deepcopy(response)
