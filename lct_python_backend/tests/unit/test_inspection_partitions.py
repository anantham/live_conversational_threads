"""Test intent: processing subdivisions cover original spans exactly once,
retain evidence and abstentions, and cannot silently skip a failed partition.
"""
import copy
import pytest
from lct_python_backend.services.transcript.inspection_partitions import partition_page, merge_partitions
from lct_python_backend.services.transcript.source_inspection import validate_inspection
from lct_python_backend.services.transcript.source_inspection_pages import plan_inspection_pages
from lct_python_backend.tests.unit.test_source_inspection import envelope


def test_partition_merge_keeps_every_source_and_exact_citation():
    page = plan_inspection_pages([{'id': f'u{i}', 'sequence_number': i, 'text': f'Question {i}?'} for i in range(5)], envelope=envelope())[0]
    parts = partition_page(page, 2)
    assert [len(p['spans']) for p in parts] == [2, 2, 1]
    assert [s for p in parts for s in p['spans']] == page['spans']
    receipts = []
    for part in parts:
        s = part['spans'][0]
        raw = {'reviewed_span_ids': [s['span_id'] for s in part['spans']],
               'observations': [{'kind': 'question', 'text': s['text'], 'citations': [{'span_id': s['span_id'], 'quote': s['text']}]}]}
        receipts.append({'page': part, 'result': validate_inspection(raw, part)})
    merged = merge_partitions(page, receipts)
    assert len(validate_inspection(merged, page)['observations']) == 3
    with pytest.raises(ValueError): merge_partitions(page, receipts[:-1])
    bad = copy.deepcopy(receipts)
    bad[0]['result']['observations'][0]['citations'][0]['quote'] = 'Invented'
    with pytest.raises(ValueError): merge_partitions(page, bad)
