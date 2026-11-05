# Hosted recording transcript files

2026-10-02. Use synthetic tokens and files only; provider, microphone and personal-upload activation remain separate.

- Export finalized Soniox tokens into a bounded recording-transcript file with stable utterance IDs, speaker labels and timestamps in seconds. Preserve exact final text; omit provisional tokens and mark partial output explicitly.
- Validate token/metadata/byte bounds through the public adapter. Never silently truncate, invent a graph/summary, add an identity/credential, or infer completed transcription from a partial session.
- The guest page prepares a local file only after capture ends. A separate explicit private-save action uses the existing authenticated file API; synthetic-only mode keeps that action disabled. No public or private upload occurs automatically.
- Navigation/new recording releases local file URLs; save cancellation/timeout preserves the transcript and warns about uncertain persistence. A readable local JSON fallback supports browsers that do not produce Blob downloads.
- Verify artifact content, actual private request bytes/type/consent/auth headers, partial/final behavior, cancellation and cleanup. Native entry/disabled settings are distinct from real transcription or cross-account proof.
