# Option B Local STT Migration Plan

**Date:** 2026-01-12  
**Status:** Draft (awaiting confirmation before implementation)

## Objective

Switch the live conversation path (currently tied to AssemblyAI) to the local STT/`/ws/transcripts` architecture described in Option B:

1. Stream audio only to the on-device Whisper/Parakeet server and keep the backend text-only.
2. Persist every partial transcript to an append-only `transcript_events` table (word/segment timestamps included) and collapse to a final `utterance`.
3. Provide chunked audio upload when the user opt‑ins via STT settings (default is text-only).
4. Govern behavior via a global STT config (env defaults with DB overrides stored in `app_settings`).
5. Minimal split + refactor of `AudioInput` to isolate capture/WS logic.


## Architecture Snapshot

1. **Audio Capture (frontend)** uses `getUserMedia`, downsamples to 16kHz, and:
   - streams PCM to a local STT WebSocket (`provider -> partial/final transcripts + timestamps`),
   - optionally streams PCM to `/api/conversations/{id}/audio/chunk` (chunked upload) when `store_audio` is on.
2. **STT provider** (Whisper/Parakeet) emits partial/final JSON events. Each event contains text and optional word/segment timestamps.
3. **Backend `/ws/transcripts`**:
   - Accepts `session_meta` (conversation_id, provider, store_audio flag, speaker_id, metadata).
   - Immediately inserts every transcript chunk into `transcript_events`, including timestamps.
   - On `final` events, creates/updates an `Utterance`, increments conversation counters, and emits existing JSON updates via the `TranscriptProcessor`.
4. **Settings store**: environment variables provide defaults (`DEFAULT_STT_PROVIDER`, `DEFAULT_STT_WS_URL`, `STT_STORE_AUDIO_DEFAULT`, `STT_AUDIO_ENDPOINT`, `STT_AUDIO_RECORDINGS_DIR`, retention policy). These defaults are layered with overrides persisted as JSON in `app_settings` keyed by `stt_config`.
5. **Audio storage** service handles chunk append, finalization (WAV/FLAC), `AUDIO_DOWNLOAD_TOKEN`, and stores metadata (chunk_id, session_id).


## Backend Workstreams

| Task | Description |
| --- | --- |
| `app_settings` + config loader | New table with `key`, `value JSONB`, timestamps; helper to read/write `stt_config`. Settings API (`GET/PUT /api/settings/stt`) returns merged env + DB. |
| `transcript_events` table | Columns: `id`, `conversation_id`, `utterance_id`, `provider`, `event_type` (partial|final), `text`, `word_timestamps`, `segment_timestamps`, `speaker_id`, `sequence_number`, `metadata JSONB`, `received_at`. Partial events only have `utterance_id` null. |
| Conversation bootstrap | `ensure_live_conversation(conversation_id, metadata)` creates `Conversation` row (type `live_audio`, `source_type` `audio_stream`, default owner) if missing. |
| Audio storage service | Handles chunked writes (.pcm) per `session_id`/`conversation_id`, finalizing to WAV/FLAC, respects opt-in flag, exposes `save_chunk`/`finalize_audio`. |
| `/ws/transcripts` WebSocket | New endpoint replacing `/ws/audio`. Accepts `session_meta`, `transcript_partial`, `transcript_final`. Each message persists to `transcript_events`, updates running utterance(s), and notifies frontend with graph updates via `TranscriptProcessor`. Should also stream `chunk_dict` updates and existing JSON. |
| Audio chunk endpoints | `POST /api/conversations/{conversation_id}/audio/chunk` (append PCM), `POST /api/conversations/{conversation_id}/audio/complete` finalizes file and returns download URLs. |
| Transcript processor integration | Reuse `TranscriptProcessor` (currently moved to `services/transcript_processing.py`). Provide hooks for new socket to feed text and send graph updates. |
| Logging/Telemetry | Gate extra logs with `STT_DEBUG`. Ensure error messages describe context (session_id, conversation_id). |


## Frontend Workstreams

| Task | Description |
| --- | --- |
| Audio capture hooks | Split `AudioInput` into `useAudioCapture`, `useSttSocket`, `useTranscriptSocket`, and `src/components/audio/pcm.js` for downsampling/Int16 conversion. |
| STT settings UI | Create `SttSettingsPanel` under `pages/settings/` for provider selection, streaming URL, and `store_audio` toggle. Fetch/persist via `/api/settings/stt`. |
| Transcription flow | `AudioInput` now orchestrates: start/stop audio context, connect to local STT WebSocket, relay transcript events to backend `/ws/transcripts`, optionally upload PCM chunks. |
| Chunk upload | When `store_audio` true, queue PCM chunks and POST to chunk endpoint; on stop, send `audio/complete` and show download link (token). |
| Settings storage | Add `sttSettingsApi` to handle GET/PUT; ensure defaults shown in UI with overrides. |
| Tests | Add RTL tests for `SttSettingsPanel` and hooks. Ensure `AudioInput` tests cover new split logic. |


## Data & Migration

1. Add Alembic revision to create `app_settings` and `transcript_events`.
2. Add indexes on `conversation_id`, `utterance_id`, `provider`, `event_type`, `created_at`.
3. Ensure retention (forever by default) is documented; eventual TTL logic can be added later.


## Testing

- **Backend unit**: `transcript_events` insert logic, conversation bootstrap, audio storage service.
- **Backend integration**: simulate websocket session (partial/final), verify events persisted, utterance created, chunk URLs returned.
- **Frontend**: `useAudioCapture` / `useTranscriptSocket` tests (mock websockets), `SttSettingsPanel` interactions, ensure chunk uploads triggered when opt-in.
- **Golden dataset harness**: plan to reuse `/Users/aditya/Documents/audio` after we have CLI to run Option B.


## Docs & ADRs

1. Create ADR (e.g., `ADR-008-local-stt-transcripts.md`) capturing:
   - why Option B.
   - transcript event table + append-only retention.
   - settings storage strategy (env + DB).
   - audio opt-in storing policy.
2. Update `docs/WORKLOG.md` with timestamps for each milestone.
3. Update `TESTING.md` and `API_DOCUMENTATION.md` once endpoints exist.


## Assumptions

1. Local STT providers speak the same partial/final protocol (text + timestamps).
2. There will be no need to support AssemblyAI after migration (Assembly keys can be removed).
3. `Conversation` owner/visibility defaults are acceptable for live audio streams.


## Predicted Tests

1. WebSocket flows will pass when transcripts persist and `utterance` count increases; 4 failures expected in `transcript_events` tests if sequence numbers skip.
2. Settings API will return env-provided defaults when DB record missing, and allow overrides.
3. Chunked audio uploads only succeed when `store_audio` true.
4. Frontend audio input tests verifying `push` path for both provider and backend connections should pass once sockets mocked.


## Confidence & Fallback

- **Confidence:** 0.65 (the overall plan depends on STT provider message format and new frontend hooks).  
- **Fallback:** If local STT websockets cannot be stabilized, we can temporarily keep `/ws/audio` and use it with a light proxy that forwards to STT, allowing backend to continue partial accumulation while we finish migration.
