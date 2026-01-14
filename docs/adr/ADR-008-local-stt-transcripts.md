# ADR 008: Local STT ingestion with append-only transcript events

**Date:** 2026-01-12  
**Status:** Approved

## Issue

The live conversation path currently proxies microphone audio through AssemblyAI and then forwards final transcripts to the backend. This means audio leaves the local device, we cannot persist partial transcripts, and the backend is tied to a single external provider. We need a text-first ingest path that keeps audio on-device, persists every partial transcript (with timestamps), and allows humans to opt into storing audio chunks for future reprocessing.

## Decision

Switch to the Option B architecture:

1. Capture microphone audio in the browser, stream it to a local STT server (Whisper/Parakeet), and send only text/timestamp events to the backend.
2. Introduce a new `/ws/transcripts` WebSocket that accepts `session_meta`, `transcript_partial`, and `transcript_final` messages, persists every event to a `transcript_events` table, and creates an `Utterance` when a final transcript arrives.
3. Store STT configuration in an `app_settings` key/value table while exposing defaults through env vars (`DEFAULT_STT_*`, `STT_STORE_AUDIO_DEFAULT`, `STT_AUDIO_*`). The frontend has a “STT Settings” panel to override provider URL, endpoints, and the audio opt-in switch.
4. Provide chunked audio upload endpoints (`POST /api/conversations/{id}/audio/chunk` and `/audio/complete`) that only run when `store_audio` is enabled; convert PCM chunks to WAV/FLAC with `AudioStorageManager` and reuse the existing audio download endpoint (token gated).
5. Frontend uploads text events and optional audio chunks, and the backend streams graph updates via the existing `TranscriptProcessor`.

## Status

Completed. The backend now exposes the new routers and tables, the frontend connects to the local STT server before sending transcripts to `/ws/transcripts`, and docs have been updated to reflect the new flow.

## Consequences

- Audio never leaves the user’s device unless they toggle “store audio” and upload chunks explicitly; transcripts are appended immediately for audit.
- Backend now retains per-event metadata (word/segment timestamps) in `transcript_events`, enabling future reprocessing or analytics on interim data.
- Settings are centrally managed so we can swap providers or endpoints without redeploying; overrides persist in the database.
- Deployment still requires a local STT server running and accessible to the browser (e.g., via Tailscale), and the new endpoints need to be covered by health probes and documentation.

## Assumptions

- Local STT providers stream partial/final JSON messages with text and timestamps.
- Conversations are created on demand and assigned a stable `conversation_id` before transcripts arrive.
- Audio chunk uploads use PCM (16k mono) so they can be round-tripped through FFmpeg and served via the download endpoint.

## Related

- `docs/plans/2026-01-12-option-b-implementation-plan.md`
- `lct_python_backend/stt_api.py`
- `lct_app/src/components/AudioInput.jsx`
