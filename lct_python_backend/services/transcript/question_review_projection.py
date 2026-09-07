"""A review-qualified read model, never a replacement for the source ledger.

Review is model interpretation, not human acceptance or truth verification.
Keep excluded asides, uncertainty and original judgments visible for audit.
"""
import copy
from .question_review import validate_question_review


def project_question_review(request, review):
    fields = ('event_id', 'scope', 'resolution', 'reason', 'evidence_ids')
    raw = {'assessments': [{key: row[key] for key in fields} for row in review['assessments']]}
    if validate_question_review(raw, request) != review:
        raise ValueError('Question review binding or evidence differs from request')
    judgments = {row['event_id']: row for row in review['assessments']}
    status, unresolved, events = 'open', [], []
    for index, original in enumerate(request['events']):
        event = {'original': copy.deepcopy(original)}
        if index:
            assessment = judgments[original['event_id']]
            event['assessment'] = copy.deepcopy(assessment)
            scope, resolution = assessment['scope'], assessment['resolution']
            if scope == 'uncertain' or resolution == 'uncertain':
                status = 'uncertain'
                unresolved.append(original['event_id'])
            elif scope == 'same_question':
                if resolution == 'complete_answer':
                    status = 'answered'
                elif resolution == 'explicit_withdrawal':
                    status = 'withdrawn'
                elif resolution == 'explicit_reopening':
                    status = 'open'
                elif resolution == 'partial_answer' and status in ('answered', 'withdrawn'):
                    event['transition_issue'] = 'partial_answer_after_closure'
                    unresolved.append(original['event_id'])
                    status = 'uncertain'
            # An aside, an unrelated remark or a clarification is not a state
            # transition. In particular, it cannot silently resolve uncertainty.
        events.append(event)
    return {'question_id': request['question_id'], 'request_hash': review['request_hash'],
            'provisional_status': request['provisional_status'], 'reviewed_status': status,
            'events': events, 'unresolved_events': unresolved,
            'verification': 'model_reviewed_not_human_verified'}
