# Test intent: map structure quality (2026-11-04)

Reading 28 valid 20-minute maps against their transcript (`docs/reviews/2026-11-03-long-input-envelope.md`) found:
a turn-level granularity floor, 3–32 chunks for the same input, pass-through tiers, and chunks filed under ideas
whose evidence excludes them. These tests pin the remedies.

## Structure scorer (`src/services/cloud/mapStructure.js`)
- Counts tiers, chunk sizes in words, backchannel chunks (≤5 words), single-child parents, and parent links whose
  child cites utterances the parent's evidence lacks, split by the child's tier, with examples.
- Runs on bundles produced by the real adapter, so ids and parent links have the production shape.
- An empty or malformed bundle gives zero counts; it never throws.

## Long-turn splitting (`src/services/cloud/recordingTranscript.js`)
- A same-speaker turn that has reached 60 s or 150 words starts a new utterance after the next token that ends a
  sentence (`.`, `?` or `!`). It never cuts mid-sentence, and short turns are unchanged.
- Untimed tokens split on words alone. Speaker changes still start a new utterance as before.
- Prefix-stable: the utterances of any prefix of the tokens are the same as the first utterances of the whole
  transcript, so periodic maps of a live session keep earlier ids.

## Parent-coverage warning (`sites/openRouter.js`)
- A generated map with misfiled children is still returned. The Worker logs `evidence_mismatch` with counts by tier
  and examples, warning and never suppressing. A clean map logs nothing.

## Prompt guidance (`src/services/cloud/openRouterGeneration.js`)
- The system prompt asks for one coherent moment per chunk (merging backchannels), no single-child tiers, parent
  evidence covering its children, and tangents as their own idea. The effect is measured by a paid A/B with the
  scorer plus a reading of the maps, not by this unit test.
