# Range citations (tiered-ranges-v3, 2026-11-25)

- Chunks cite one contiguous `{from, to}` utterance range; the app expands it to explicit IDs, so the
  model copies two IDs per chunk instead of every ID, and the saved `.threads` format is unchanged.
- Higher tiers cite nothing; evidence is derived from primary children (laminar backbone). Secondary
  parents are cross-links that never widen evidence. A topic revisited later is one node whose
  evidence is a union of separate stretches.
- Turns no chunk covers become explicit root "Uncovered turns" chunks, shown and counted, never
  silently dropped. Overlapping chunks are kept and counted.
- Unknown or reversed range endpoints reject the window with a named stage (`node_evidence`, `threads`).
- Legacy v2 replies with explicit ID lists are still accepted unchanged.
