# Glance → detail generation (2026-11-25)

- One whole-conversation call (task `skeleton`) writes arcs, themes and topics; topics cite one or more
  utterance ranges, so a subject the conversation returns to is one topic over separate stretches.
- Detail calls (task `detail`) map chunks and ideas for segments built from whole topics (sized by
  words, not clock); ideas file under the segment's real topics, which the server adds as stubs.
- Merged evidence flows up from primary children only: chunk ⊆ idea ⊆ topic ⊆ theme ⊆ arc, and a
  detailed topic's evidence is exactly its chunks.
- Nothing is silently dropped: uncovered turns become explicit nodes; boundary notes (missed topic,
  wrong boundary, unfiled) and skeleton-vs-detail boundary shifts are recorded in `audit_signals`.
- A truncated detail segment is halved (depth 2); `detail: 'none'` returns the skeleton, and
  `expandTopicDetail` details one topic on demand.
- Non-adjacent same-speaker turns in a segment never merge (one utterance per turn, asserted at merge).
