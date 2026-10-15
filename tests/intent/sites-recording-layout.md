# Cloud recording layout restoration

- Restore the original full-height conversation canvas and bottom microphone toolbar on `/new`; keep navigation compact and recording controls outside the scrollable results area.
- Guest access never starts capture automatically. Both recording modes still require fresh consent; cancellation, stop/finalization focus and inactive transcription remain intact.
- Recorded audio, transcript, map generation and explicit private/public actions stay reachable inside the canvas without moving the bottom controls off screen.
- Setup, recording, saving and failure/retry keep stage, elapsed time and cancellation readable. The account panel must not cover the toolbar.
- Use isolated synthetic sessions and data only. Validate public behavior and the layout contract; real desktop/mobile rendering is a separate evidence boundary.
- 2026-10-12 copy-only request: remove “Nothing is published automatically.” from the canvas, footer and dialog introduction. Preserve guest capture, mode-specific participant/provider permission and explicit saving; keep the footer's mobile-center/desktop-right alignment after deleting its left text. Adjust existing copy assertions; no new feature or test fixture is needed.

## 2026-10-15 single microphone

- One Start/Stop microphone; Live transcription switch selects the session mode. Default to transcription when available, audio-only when unavailable, and preserve an explicit choice through capability refreshes.
- Starting freezes the displayed mode for the existing fresh consent dialog. Switching alone never captures audio or calls a provider. If selected transcription becomes unavailable, refuse start until the user explicitly chooses audio-only.
- Verify both modes, cancellation/focus restoration, disabled controls during recording/save/generation, retry/availability changes, retained results and desktop/mobile canvas/footer layout with isolated synthetic data.
