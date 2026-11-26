# Recording starts directly, and the recording screen stays clean

- **Date:** 2026-11-26
- **Status:** Proposed
- **Group:** presentation

## Issue

Pressing Start opened a modal with a "I have permission to record everyone" checkbox before anything
began. While recording, the screen also showed a status line, an elapsed timer, "Keep this tab open", a
centre block ("Your threads will take shape here" with a "Set up live map" link) and two buttons that
looked alike: Stop and "Cancel session". The owner asked for all of that to go ("the friction that's
unrequired", "I don't see why we have two buttons").

## Decision

- **Start records at once.** The consent dialog, its checkbox and its remembered-introduction key
  (`lct.recording_intro.v1`) are removed. The browser's own microphone prompt remains the permission step.
- **One way to end.** The toolbar shows Pause and Stop. "Cancel session" is gone. Stop finalises the session
  (bounded at 10 s) and keeps the audio and transcript. Cancel aborted instead and kept the audio only
  as incomplete, so the one remaining button is the safer one.
- **Quiet recording screen.** The status line is kept for assistive technology (`sr-only`), the timer and
  "Keep this tab open" are removed, and the empty-map placeholder is not drawn while recording.
- **Disclosure moves to Settings.** A short note states that recording begins on Start, which mode is
  active (Soniox streaming, or local only) with the real limits, and links to `/privacy`.
- **The Sign in chip no longer carries a Privacy link.** The same link is still in the expanded panel.
- **Kept on purpose:** the "Start another recording?" confirmation, because starting over replaces an
  unsaved recording.

## Consequences

- No in-product step now asks the person to confirm they may record others. The owner chose this; the
  Settings note and `/privacy` carry the statement instead. If a deployment needs recorded consent,
  that is a new decision.
- Soniox still receives `X-LCT-Soniox-Consent: transcribe-v1` unconditionally, as before.
- A user who never opens Settings never sees the data-use note on this page.
- Mode no longer freezes when Start is first pressed, because pressing Start now begins recording. The
  switch follows availability until the user toggles it.

## Related

`tests/intent/sites-compact-recording.md`, `tests/intent/recording-screen-clean.md`.
