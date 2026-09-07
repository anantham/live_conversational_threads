"""Source selection preserves raw utterance text, not reconstructed quotations."""
import copy
import pytest
from lct_python_backend.services.transcript.question_evidence import attach_question_evidence, question_source_lines
from lct_python_backend.services.transcript.question_memory import fold_question_memory


def test_selected_fragments_attach_exact_covering_source_and_keep_question_open():
    fragments = ['Who pays?', 'Let us consider the garden.', 'Hosting is covered, staffing is not.']
    passage = ' '.join(fragments)
    updates = [{'question_id': 'funding', 'action': action, 'wording': 'Funding inquiry',
                'rationale': 'Explicit statement', 'evidence_line_ids': ids}
               for action, ids in [('open', ['line-0']), ('partial_answer', ['line-0', 'line-2'])]]
    nodes = [{'id': 'n', 'chunk_id': 'c', 'question_updates': updates}]
    before = copy.deepcopy(nodes)
    repaired = attach_question_evidence(nodes, passage, fragments)
    assert repaired[0]['question_updates'][1]['evidence_quote'] == passage
    assert fold_question_memory(repaired, {'c': passage})['funding']['status'] == 'open'
    assert nodes == before
    assert question_source_lines(passage, fragments)[2]['start'] == passage.index(fragments[2])


@pytest.mark.parametrize('ids', [[], ['unknown'], ['line-0', 'line-0']])
def test_invalid_source_selection_is_not_guessed(ids):
    with pytest.raises(ValueError):
        attach_question_evidence([{'question_updates': [{'evidence_line_ids': ids}]}], 'source')


def test_rendered_speaker_text_cannot_be_mistaken_for_raw_source():
    with pytest.raises(ValueError, match='differ'):
        question_source_lines('[A]: source', ['source'])
