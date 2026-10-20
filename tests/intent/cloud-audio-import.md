# Cloud audio import test intent

- MP3, WAV and M4A decode locally into mono 16 kHz PCM; unsupported, empty, oversized, corrupt or over-duration files refuse before a temporary-key request. Cancellation ignores late decoder results and never opens the microphone.
- One deliberate import uses one existing Soniox session at near-real-time cadence, preserves finalized speaker/timing tokens, and retains original audio on provider failure or cancellation. No automatic provider retry or limit reset.
- After successful transcription, one consented Gemini/OpenRouter map uses the exact finalized source. Refusal/cancellation retains audio and transcript; no automatic cloud history or publication.
- Original audio, transcript and map save through the existing browser archive by default, survive reload and export with correct extensions. Ephemeral mode writes no conversation data; quota failures stay visible and retryable.
- Verify actual browser decoding for all three formats, one real provider journey, mobile/keyboard layout, cancellation/refusal, adjacent microphone regressions and required combined tests before independent review and existing-Site publication.
