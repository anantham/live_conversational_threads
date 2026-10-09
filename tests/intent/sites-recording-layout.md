# Cloud recording layout restoration

- Restore the original full-height conversation canvas and bottom microphone toolbar on `/new`; keep navigation compact and recording controls outside the scrollable results area.
- Guest access never starts capture automatically. Both recording modes still require fresh consent; cancellation, stop/finalization focus and inactive transcription remain intact.
- Recorded audio, transcript, map generation and explicit private/public actions stay reachable inside the canvas without moving the bottom controls off screen.
- Setup, recording, saving and failure/retry keep stage, elapsed time and cancellation readable. The account panel must not cover the toolbar.
- Use isolated synthetic sessions and data only. Validate public behavior and the layout contract; real desktop/mobile rendering is a separate evidence boundary.
