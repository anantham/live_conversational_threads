"""Lossless processing windows over source, never conversation/thread partitions.

Offsets are Python/Unicode code-point indices, not UTF8 bytes or media times.
Only request-local spans split; canonical utterances and timestamps stay intact.
Caller must supply an authorized stable snapshot. This module performs no I/O.
"""
import copy
import json

from .conversation_context import ContextBudgetExceeded
from .passage_journal import _hash

FIELDS = ('id', 'sequence_number', 'text', 'speaker_id', 'speaker_revision',
          'timestamp_start', 'timestamp_end')


def inspection_sources(sources):
    rows = [copy.deepcopy({key: row[key] for key in FIELDS if key in row}) for row in sources]
    if not rows or any(not isinstance(row.get('id'), str) or not row['id']
                       or not isinstance(row.get('text'), str)
                       or type(row.get('sequence_number')) is not int for row in rows):
        raise ValueError('Inspection requires nonempty identified, sequenced text sources')
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('Inspection source identities must be distinct')
    rows.sort(key=lambda row: row['sequence_number'])
    if len({row['sequence_number'] for row in rows}) != len(rows):
        raise ValueError('Inspection source sequences must be distinct')
    return rows


def source_span(source, start, end):
    # Local citation handles are scoped by the page's full source snapshot hash.
    # Avoid making the model copy a 64-hex digest for every acknowledgement.
    return {'span_id': f"s{source['sequence_number']}:{start}-{end}", 'utterance_id': source['id'],
            'sequence_number': source['sequence_number'], 'start': start, 'end': end,
            'source_length': len(source['text']), 'text': source['text'][start:end],
            **{key: source[key] for key in ('speaker_id', 'speaker_revision', 'timestamp_start', 'timestamp_end')
               if key in source}}


def plan_inspection_pages(sources, *, envelope):
    """Greedily pack exact spans, checking complete provider messages each time.

Binary search finds a fitting prefix when even a lone source is too large.
Every chosen prefix is validated independently, so a custom counter never
admits an overflowing request even if its length estimates are nonmonotonic.
"""
    rows = inspection_sources(sources)
    snapshot_hash = _hash(rows)
    pages, spans = [], []

    def page(parts):
        return {'source_snapshot_hash': snapshot_hash, 'page_index': len(pages),
                'offset_unit': 'unicode_codepoints', 'spans': parts}

    def fits(parts):
        try:
            envelope.validate(json.dumps(page(parts), ensure_ascii=False, separators=(',', ':')))
            return True
        except ContextBudgetExceeded:
            return False

    for source in rows:
        start, length = 0, len(source['text'])
        while True:
            candidate = source_span(source, start, length)
            if fits([*spans, candidate]):
                spans.append(candidate)
                break
            if spans:
                pages.append(page(spans))
                spans = []
                continue
            low, high, best = start + 1, length, start
            while low <= high:
                end = (low + high) // 2
                if fits([source_span(source, start, end)]):
                    best, low = end, end + 1
                else:
                    high = end - 1
            if best == start:
                raise ContextBudgetExceeded('Inspection metadata and one source character cannot fit')
            # Prefer a nearby sentence/word boundary without discarding whitespace.
            prefix = source['text'][start:best]
            boundary = max(prefix.rfind('\n'), prefix.rfind(' ')) + 1
            if boundary >= len(prefix) * 0.8 and fits([source_span(source, start, start + boundary)]):
                best = start + boundary
            pages.append(page([source_span(source, start, best)]))
            start = best
    if spans:
        pages.append(page(spans))
    return pages
