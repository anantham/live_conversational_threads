# Discussion view test intent

- Expand and collapse the existing semantic hierarchy with accessible buttons; show exact utterance text and speaker initials.
- Show distinct, labeled speaker colors before expansion and on branches. Render raw diarization IDs as readable placeholders, then reflect a human supplied name without guessing identity.
- Preserve a supplied name even when a transcript row has no diarization ID. Placeholder cleanup currently recognizes `SPEAKER_nn`; other opaque ID formats need a separate data sample before broadening.
- Keep a shared child reachable from both parents without duplicating its subtree; shared links open and focus its canonical location.
- Preserve disconnected lower tiers and unlinked transcript passages; missing source text must never be replaced by a generated summary.
- Saved conversations keep Graph as default and load Discussion on demand with observable waits, retry and cancellation; artifacts read only local bundled utterances.
- Exercise synthetic straight, shared two-parent and three-parent, and sparse/missing-utterance conversations.

- Start artifact Graph and Discussion with overview, source, and thread timeline
  closed; the shared toolbar controls each independently at desktop and phone
  widths without covering graph cards.
- Find lists a specific question or claim only when useful. Missing support and
  rebuttal links describe authored graph relationships, never factual verdicts.
  A result opens the matching Discussion branch.
- Display controls keep a consistent single-line width, including Time order,
  which toggles chronological arrows rather than changing layout.
- Tier references, speaker tint, and stable branch links help readers identify
  and share a tangent; a deep link reopens the canonical branch without copying
  the underlying conversation.
- A link added while the page is open selects Discussion; later data refreshes
  do not steal focus from the reader. Copy feedback is announced and exposes
  the URL for manual copying when clipboard access fails.
- Compact Graph reveals its overview when requested; resizing Cards to a wide
  viewport restores Graph controls. Links opened from Focus exit that mode.
  Find keeps long result lists scrollable within a narrow screen.
- Source stacks above the canvas on narrow screens and closes when Focus starts.
  Find and More remain scrollable at short viewport heights. Timeline selection
  and semantic level behave consistently in Graph and Discussion.
