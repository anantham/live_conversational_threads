"""Question reconciliation intent:
- Review original scope plus every intervening event against exact source.
- Related asides and uncertainty are distinct from progress or resolution.
- Invalid references fail; review never mutates the historical question ledger.
"""
import copy
import pytest
from lct_python_backend.services.transcript.question_review import build_question_review, validate_question_review
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded


class Envelope:
    def validate(self, prompt):
        if len(prompt) > 10000:
            raise ContextBudgetExceeded('Too large')


def fixture():
    texts = ['What did Mira study?', 'Her friend studied astronomy.', 'Mira studied music.']
    return ([{'id': str(i), 'chunk_id': str(i), 'question_updates': [{
        'question_id': 'studies', 'action': 'open' if i == 0 else 'partial_answer',
        'wording': text, 'evidence_quote': text, 'rationale': 'Speaker statement'}]}
        for i, text in enumerate(texts)], dict(enumerate(texts)))


def test_review_preserves_original_and_aside_without_rewriting_ledger():
    nodes, chunks = fixture()
    chunks = {str(k): v for k, v in chunks.items()}
    before = copy.deepcopy(nodes)
    request = build_question_review(nodes, chunks, 'studies', envelope=Envelope())
    assert [event['action'] for event in request['events']] == ['open', 'partial_answer', 'partial_answer']
    result = validate_question_review({'assessments': [
        {'event_id': 'event-1', 'scope': 'related_aside', 'resolution': 'not_an_answer',
         'reason': 'A different person is the subject.', 'evidence_ids': ['source-0', 'source-1']},
        {'event_id': 'event-2', 'scope': 'same_question', 'resolution': 'complete_answer',
         'reason': 'The named subject and inquiry match.', 'evidence_ids': ['source-0', 'source-2']}]}, request)
    assert result['assessments'][0]['evidence'][1]['text'] == chunks['1']
    assert result['accepted_for_projection'] is False
    assert nodes == before


@pytest.mark.parametrize('change', ['missing', 'foreign', 'contradiction'])
def test_invalid_review_cannot_be_silently_accepted(change):
    nodes, chunks = fixture()
    request = build_question_review(nodes, {str(k): v for k, v in chunks.items()}, 'studies', envelope=Envelope())
    rows = [{'event_id': f'event-{i}', 'scope': 'uncertain', 'resolution': 'uncertain',
             'reason': 'Unclear', 'evidence_ids': ['source-0', f'source-{i}']} for i in (1, 2)]
    if change == 'missing': rows.pop()
    if change == 'foreign': rows[0]['evidence_ids'] = ['source-0', 'unavailable']
    if change == 'contradiction': rows[0].update(scope='related_aside', resolution='complete_answer')
    with pytest.raises(ValueError):
        validate_question_review({'assessments': rows}, request)


def test_over_budget_history_is_not_cropped():
    nodes, chunks = fixture()
    chunks = {str(k): v + ' context' * 2000 for k, v in chunks.items()}
    with pytest.raises(ContextBudgetExceeded):
        build_question_review(nodes, chunks, 'studies', envelope=Envelope())


def test_multiple_updates_share_one_unabridged_source_passage():
    nodes, chunks = fixture()
    passage = ' '.join(chunks.values())
    for node in nodes:
        node['chunk_id'] = 'shared'
    request = build_question_review(nodes, {'shared': passage}, 'studies', envelope=Envelope())
    assert request['sources'] == [{'id': 'source-0', 'chunk_id': 'shared', 'text': passage}]
    assert {event['source_id'] for event in request['events']} == {'source-0'}
    assert len(request['events']) == 3
