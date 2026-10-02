# Viewer exploration — test intent

- Follow the real seven-moment public thread through previous/next buttons and
  arrow keys with details open; cards remain readable and do not overlap. A
  source timestamp opens Source and cues the correct recording position.
- Show speaker shares from measured speaking time over unique linked source
  passages. Shared descendants do not double count. Missing timing is explicit;
  a brief acknowledgement does not produce an equal speaker blend.
- Cycle available views with one control, keep secondary actions identifiable
  with icons, align detail disclosures, and name speakers in Source with their
  actual timestamped words. Preserve the original transcript on rename/export.
- Search all branches and source passages by text and meaning on the device.
  Verify a real model result, no transcript/query network egress, observable
  download/indexing stages, elapsed time, measured completed work, cancellation,
  retry, no-history timing, and narrow-screen status presentation.

Public source playback worked on a successful load. That observation does not
establish that a player is visible on every load. Preserve deliberate playback:
selecting a passage cues it; the reader presses Play to listen.

## 2026-10-02 — Blank video correction

- Reproduce a blocked embed after the YouTube API loads. Loading must show its
  stage and elapsed time inside the video area, then a clear error and Retry;
  a timestamped YouTube link stays available without waiting for success.
- Once the player is ready, provide a visible Play video control outside the
  embedded frame. Confirm that it starts at the selected passage, becomes Pause
  on actual playback, and responds to the native player's state changes.
- A player that reports readiness after a timeout must not revive a failed
  attempt. Retry preserves the selected passage; closing Source cancels timers.
- Exercise browser-blocked playback and show the external recording fallback.

Hypothesis: an embed can remain blank after SDK success without emitting an
error. Prediction: blocking the embed request on the released viewer leaves
one iframe, zero alerts/statuses/recovery links after 22 seconds. This was
observed; a normal load showed a thumbnail and native Play. The user's specific
blocking cause remains unknown. Confidence in this failure class: 0.95.
The bounded correction exposes state and controls; if embedding still fails,
the reader can open the exact passage on YouTube.

## 2026-10-02 — Live phone Source obstruction

- With the timeline expanded and a moment selected, opening Source on a phone
  temporarily hides the selected-node sheet while preserving the selected moment.
  Closing Source restores that detail; desktop details remain available beside Source.
- Source uses a bounded share of its available pane height, retaining space for
  the graph. Floating graph actions cannot escape into Source. Naming a speaker
  must succeed by an ordinary click and keyboard input, without a forced click.

Instrument: the live 390x844 flow reached Source but its naming click was intercepted
by the graph's reading control, while a selected-node sheet also covered Source.
Hypothesis: the Source cap used the full remaining height and graph actions escaped
their zero-height pane; the phone detail sheet remained rendered over Source.
Prediction: containing the graph and suspending the phone sheet while Source is open
makes naming reachable, with navigation below Source and the same detail restored.
Confidence: 0.95. Fallback: retain the current deployed desktop behavior and report
the phone correction incomplete if the focused browser interaction does not pass.
