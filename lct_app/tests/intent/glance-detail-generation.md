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
- The overview is re-asked at most once (2026-11-27, from the finer-maps study): a structural refusal
  is asked again with the refused rule named (a second refusal fails the map; provider failures and
  truncation are not re-asked); an accepted overview whose topics leave turns out is asked again with
  those turns named, the reply leaving fewer turns out is kept, and any still left out stay under the
  "Uncovered turns" placeholder (also when the re-ask fails). A re-ask is paced like a detail call and
  a 429 admission refusal waits and tries again.
