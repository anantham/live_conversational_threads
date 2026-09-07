"""Select current source lines; attach a verbatim covering range in the backend.

The range may include intervening context. No text is omitted with ellipses and
no speaker boundary is rewritten. Selection is evidence, not semantic proof.
"""
import copy


def question_source_lines(passage, fragments=None):
    if fragments is not None and ' '.join(fragments) != passage:
        raise ValueError('Question source fragments differ from committed passage')
    offset, lines = 0, []
    for index, text in enumerate(fragments if fragments is not None else passage.splitlines(keepends=True)):
        lines.append({'id': f'line-{index}', 'start': offset, 'end': offset + len(text), 'text': text})
        offset += len(text) + (1 if fragments is not None else 0)
    return lines


def attach_question_evidence(nodes, passage, fragments=None):
    lines = {line['id']: line for line in question_source_lines(passage, fragments)}
    output = copy.deepcopy(nodes)
    for node in output:
        for update in node.get('question_updates', []):
            if 'evidence_line_ids' not in update:
                continue  # Legacy exact quotes still pass the existing strict validator.
            if 'evidence_quote' in update:
                raise ValueError('Question evidence cannot mix copied quotes and source selection')
            ids = update.pop('evidence_line_ids')
            if (not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in lines for i in ids)
                    or len(ids) != len(set(ids))):
                raise ValueError('Question evidence requires distinct current source line IDs')
            start = min(lines[i]['start'] for i in ids)
            end = max(lines[i]['end'] for i in ids)
            update['evidence_quote'] = passage[start:end]
            preferences = node.setdefault('display_preferences', {})
            preferences.setdefault('question_evidence_selections', []).append({
                'question_id': update.get('question_id'), 'action': update.get('action'),
                'line_ids': ids, 'start': start, 'end': end, 'includes_intervening_context': True})
    return output
