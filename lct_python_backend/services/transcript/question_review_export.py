"""Read-only, revision-qualified question reviews for explicit artifact export.

Never select a model policy by timestamp or export superseded review content.
Multiple current policies remain separate, labelled interpretations.
"""
import uuid
from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .passage_journal import JournalConflict, _hash
from .question_memory import fold_question_memory
from .question_review_runner import capture_question_basis
from .question_review_projection import project_question_review
from .question_review import validate_question_review
from .question_basis import question_basis


async def export_question_reviews(db, *, conversation_id, owner_id):
    # Authenticate ownership even when there are no reviews to export.
    from .source_inspection_runner import _authorized_conversation
    await _authorized_conversation(db, conversation_id, owner_id, lock=False)
    rows = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == uuid.UUID(conversation_id),
        PipelineArtifact.artifact_type == 'source_reviewed_question'))).scalars().all()
    base = {'schema_version': 1, 'verification': 'model_reviewed_not_human_verified',
            'policies': [], 'superseded_review_count': 0}
    if not rows:
        return {**base, 'status': 'not_reviewed'}
    try:
        basis = await capture_question_basis(db, conversation_id=conversation_id, owner_id=owner_id)
    except JournalConflict:
        return {**base, 'status': 'source_revision_requires_reconciliation',
                'superseded_review_count': len(rows)}
    basis_hash = _hash(basis)
    expected = set(fold_question_memory(basis['state']['nodes'], basis['state']['chunks']))
    grouped = {}
    for row in rows:
        saved = row.artifact_json
        if _hash(saved) != row.content_hash:
            raise JournalConflict('Question export receipt digest mismatch')
        qid = saved['request']['question_id']
        scope = saved.get('basis_scope', 'conversation_v1')
        if scope not in ('conversation_v1', 'question_v1'):
            raise JournalConflict('Unknown question review revision scope')
        current_hash = (_hash(question_basis(basis, qid))
                        if scope == 'question_v1' and qid in expected else basis_hash)
        if qid not in expected or saved['basis_hash'] != current_hash:
            base['superseded_review_count'] += 1
            continue
        request = saved['request']
        if saved['request_hash'] != _hash(request) or request['question_id'] not in expected:
            raise JournalConflict('Question export request identity differs')
        if validate_question_review(saved['response'], request) != saved['review']:
            raise JournalConflict('Question export review no longer reproduces its response')
        policy = saved['policy_fingerprint']
        questions = grouped.setdefault((policy, scope), {})
        identity = request['question_id']
        if identity in questions:
            raise JournalConflict('Multiple current reviews for one question and policy')
        questions[identity] = project_question_review(request, saved['review'])
    base['policies'] = [{'policy_fingerprint': policy, 'revision_scope': scope, 'basis_hash': basis_hash,
                        'coverage_complete': set(questions) == expected,
                        'missing_question_ids': sorted(expected - set(questions)),
                        'questions': [questions[qid] for qid in sorted(questions)]}
                       for (policy, scope), questions in sorted(grouped.items())]
    return {**base, 'status': 'current_reviews' if grouped else 'no_current_review'}
