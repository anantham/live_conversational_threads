# Discussion view test intent

- Expand and collapse the existing semantic hierarchy with accessible buttons; show exact utterance text and speaker initials.
- Show distinct, labeled speaker colors before expansion and on branches. Render raw diarization IDs as readable placeholders, then reflect a human supplied name without guessing identity.
- Preserve a supplied name even when a transcript row has no diarization ID. Placeholder cleanup currently recognizes `SPEAKER_nn`; other opaque ID formats need a separate data sample before broadening.
- Keep a shared child reachable from both parents without duplicating its subtree; shared links open and focus its canonical location.
- Preserve disconnected lower tiers and unlinked transcript passages; missing source text must never be replaced by a generated summary.
- Saved conversations keep Graph as default and load Discussion on demand with observable waits, retry and cancellation; artifacts read only local bundled utterances.
- Exercise synthetic straight, shared two-parent and three-parent, and sparse/missing-utterance conversations.
