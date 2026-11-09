# Cloud audio import test intent

- MP3, WAV and M4A decode locally into mono 16 kHz PCM; unsupported, empty, oversized, corrupt or over-duration files refuse before a temporary-key request. Cancellation ignores late decoder results and never opens the microphone.
- One deliberate import uses one existing Soniox session at near-real-time cadence, preserves finalized speaker/timing tokens, and retains original audio on provider failure or cancellation. No automatic provider retry or limit reset.
- After successful transcription, one consented Gemini/OpenRouter map uses the exact finalized source. Refusal/cancellation retains audio and transcript; no automatic cloud history or publication.
- Original audio, transcript and map save through the existing browser archive by default, survive reload and export with correct extensions. Ephemeral mode writes no conversation data; quota failures stay visible and retryable.
- Verify actual browser decoding for all three formats, one real provider journey, mobile/keyboard layout, cancellation/refusal, adjacent microphone regressions and required combined tests before independent review and existing-Site publication.

## Live replay acceptance — 27 October

- During a held import, explicit live-map consent can build two increasing source snapshots on the same canvas before transcription completes. Existing cadence/caps and partial-word exclusion remain.
- A live map attempt owns generation for that import: completion must not race it, double-dispatch or retry a refused/uncertain request. Without a live attempt, the existing single final map remains.
- Stop processing aborts the current map wait, ignores late results, disables future automatic calls and retains original audio/confirmed words. Reopening never restarts processing.
