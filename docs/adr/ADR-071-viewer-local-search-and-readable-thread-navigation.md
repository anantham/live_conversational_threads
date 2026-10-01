# ADR-071: Local search and readable thread navigation

Date: 2026-10-01
Status: Selected by the user for implementation; independent review pending.

## Context

The public artifact viewer must support reading an authored thread from beginning
to end, returning to exact source words and recording offsets, and finding ideas
across the whole conversation. The user selected measured speaking time for
speaker fractions and device-local semantic search. They requested one cycling
view control, Source-based speaker naming, and smaller readable graph cards.

End-to-end interaction reproduced hidden Source seeks, disabled keyboard
navigation while details were open, equal speaker-ID gradients, and collisions
between time-positioned cards. Playing the source manually succeeded; that alone
did not verify the evidence-to-recording path.

## Decision

Preserve authored nodes, memberships, provenance, and original transcript bytes.
Correct presentation and navigation; do not regenerate or repartition semantics.
Use unique source-passage speaking durations for contributions, show incomplete
timing honestly, and use the dominant speaker color at a share of at least 90%.
Follow the selected thread's chronological timeline order, with visible and
keyboard navigation. Retain its authored steps and memberships unchanged.

Semantic search runs in a browser worker with a downloaded, cached embedding
model. Source text and queries remain on the reader's device. Ordinary text
search is immediately usable; model preparation is opt-in and reports measured
stage/progress, elapsed time, and cancellation. Timing history is bounded and
contains only operational measurements. No server search, API key, or inference
charge is introduced.

The implementation uses Transformers.js 4.3.0 and the quantized
[MiniLM embedding model](https://huggingface.co/Xenova/all-MiniLM-L6-v2), pinned
to revision `751bff37182d3f1213fa05d7196b954e230abad9`. Model loading and
indexing happen only after the reader chooses Search by meaning.

## Consequences

The first semantic search requires model/runtime downloads and device compute.
Devices that cannot run it retain text search and explicit recovery. Preview
cards may summarize content; full exact passages remain in the reading surfaces.
Overlapping memberships cannot inflate speaker fractions. Layout packing must
preserve chronology and real large gaps without changing source timestamps.

Validation includes real thread exploration and source playback, a real local
semantic inference, public-API regressions, and independent review of the final
bounded source diff. Raw artifacts, transcripts and browser screenshots are
excluded from external code review.

## 2026-10-02 amendment — A visible recording action

The user's screenshot shows a blank video host with no Play control. A blocked
embed probe on the released viewer reproduced this: the SDK loaded and inserted
an iframe, but no readiness/error arrived and no recovery appeared after 22s.
The ordinary load succeeded. This confirms an unhandled failure class, not the
specific cause in the user's browser.

Keep the existing bounded readiness timeout, but render loading and failure in
the video area itself. Keep the timestamped external recording link available.
Provide an explicit Play/Pause control alongside a ready player, driven by actual
player events, and explain browser-blocked playback. A timed-out attempt cannot
later become ready; Retry starts a fresh attempt at the retained passage.
No automatic playback, new media provider, or browser settings change is added.
