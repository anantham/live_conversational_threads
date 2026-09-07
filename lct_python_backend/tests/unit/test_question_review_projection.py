"""Intent: derive review-qualified question state without rewriting evidence.

Related asides cannot close inquiries; uncertainty/conflicting transitions stay
visible. Saved review bindings must be checked before any projection is returned.
"""
import copy
import pytest
from lct_python_backend.services.transcript.question_review_projection import project_question_review
from lct_python_backend.services.transcript.question_review import validate_question_review


def request():
    return {'question_id': 'studies', 'provisional_status': 'answered',
        'events': [{'event_id': 'event-0', 'action': 'open', 'wording': 'What did Mira study?', 'source_id': 'source-0'},
                   {'event_id': 'event-1', 'action': 'answer', 'wording': 'Her friend studied astronomy.', 'source_id': 'source-1'}],
        'sources': [{'id': 'source-0', 'text': 'What did Mira study?'},
                    {'id': 'source-1', 'text': 'Her friend studied astronomy.'}]}


def judgment(scope, resolution, event='event-1'):
    return {'event_id': event, 'scope': scope, 'resolution': resolution,
            'reason': 'Source-qualified assessment', 'evidence_ids': ['source-0', 'source-1']}


@pytest.mark.parametrize('scope,resolution,status', [
    ('related_aside', 'not_an_answer', 'open'),
    ('unrelated', 'not_an_answer', 'open'),
    ('same_question', 'partial_answer', 'open'),
    ('same_question', 'complete_answer', 'answered'),
    ('same_question', 'explicit_withdrawal', 'withdrawn'),
    ('uncertain', 'uncertain', 'uncertain'),
])
def test_status_comes_from_review_without_altering_original(scope, resolution, status):
    source = request()
    review = validate_question_review({'assessments': [judgment(scope, resolution)]}, source)
    before = copy.deepcopy((source, review))
    result = project_question_review(source, review)
    assert result['reviewed_status'] == status
    assert result['provisional_status'] == 'answered'
    assert result['events'][1]['original']['action'] == 'answer'
    assert result['events'][1]['assessment']['scope'] == scope
    assert result['verification'] == 'model_reviewed_not_human_verified'
    assert (source, review) == before


def test_mismatched_or_tampered_review_cannot_project():
    source = request()
    review = validate_question_review({'assessments': [judgment('same_question', 'complete_answer')]}, source)
    review['request_hash'] = 'different-source'
    with pytest.raises(ValueError, match='binding'):
        project_question_review(source, review)


def test_partial_after_reviewed_closure_requires_reconciliation_not_implicit_reopening():
    source = request()
    source['events'].append(source['events'][1] | {'event_id': 'event-2', 'action': 'clarify'})
    rows = [judgment('same_question', 'complete_answer'), judgment('same_question', 'partial_answer', 'event-2')]
    result = project_question_review(source, validate_question_review({'assessments': rows}, source))
    assert result['reviewed_status'] == 'uncertain'
    assert result['unresolved_events'] == ['event-2']
    assert result['events'][2]['transition_issue'] == 'partial_answer_after_closure'


def test_explicit_reopening_restores_open_state():
    source = request()
    source['events'].append(source['events'][1] | {'event_id': 'event-2', 'action': 'reopen'})
    rows = [judgment('same_question', 'complete_answer'), judgment('same_question', 'explicit_reopening', 'event-2')]
    result = project_question_review(source, validate_question_review({'assessments': rows}, source))
    assert result['reviewed_status'] == 'open'
