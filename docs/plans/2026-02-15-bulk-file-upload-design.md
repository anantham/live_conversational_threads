# Design: Bulk File Upload → Graph

**Date:** 2026-02-15
**Branch:** `feat/minimal-live-ui`
**Status:** Approved
**ADR:** Extends ADR-011 (minimal live conversation UI)

## Problem

The `/new` page only supports live microphone recording. Users want to upload
a pre-recorded audio file (or text transcript) and see how the graph looks
without recording live. This enables reviewing past conversations, testing
with long audio, and working with text-only transcripts.

## Decision

**Approach A: Single REST endpoint + SSE streaming.**

`POST /api/import/process-file` accepts a multipart file upload and returns
a `text/event-stream` response. The backend detects file type, transcribes
audio if needed, feeds text through `TranscriptProcessor`, and streams
progress + graph data as SSE events.

The frontend uses `fetch()` + `ReadableStream` to parse SSE frames (not
`EventSource`, which is GET-only and can't send file bodies).

## Constraints

- Route lives in `import_api.py` (prefix consistency with existing imports)
- No changes to `stt_api.py` router wiring
- SSE payload contract matches existing WebSocket messages exactly:
  - `{"type":"existing_json","data":[...]}`
  - `{"type":"chunk_dict","data":{...}}`
  - `{"type":"processing_status","level":"info|warning|error","message":"...","context":{...}}`
- `MAX_BODY_BYTES` (default 50 MB) enforced by existing middleware
- One file at a time (no batch upload)
- Cancel via `AbortController` (frontend) + `request.is_disconnected()` (backend)

## Input

`multipart/form-data` fields:

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `file` | UploadFile | yes | — |
| `source_type` | string | no | `"auto"` |
| `conversation_id` | string | no | new UUID |
| `speaker_id` | string | no | `"speaker_1"` |

`source_type` values: `auto`, `audio`, `text`, `google_meet`

- `auto`: detect from file extension
- `audio`: `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.webm`
- `text`: `.txt`, `.vtt`, `.srt`
- `google_meet`: Google Meet transcript format (existing parser)

When `source_type=auto`:
- Audio extensions → audio pipeline
- `.vtt`/`.srt` → subtitle parser
- `.txt` → ambiguous, treat as plain text (user must pick `google_meet` explicitly)

## SSE Event Protocol

Proper SSE framing: `data: {...}\n\n` per event.

### Status events (progress)

```
data: {"type":"processing_status","level":"info","message":"File received (2.4 MB)","context":{"stage":"upload","bytes_total":2516582}}

data: {"type":"processing_status","level":"info","message":"Transcribing audio...","context":{"stage":"transcribe","bytes_total":2516582,"bytes_processed":0}}

data: {"type":"processing_status","level":"info","message":"Generating graph nodes...","context":{"stage":"analyze","chunks_total":3,"chunks_done":1}}
```

Stages: `upload` → `transcribe` → `analyze` → `done`

Progress uses real counters (`bytes_total`, `bytes_processed`, `chunks_done`,
`chunks_total`), not synthetic percentages.

### Graph events (incremental results)

```
data: {"type":"existing_json","data":[...nodes...]}

data: {"type":"chunk_dict","data":{"chunk-1":"transcript text..."}}
```

Same contract as WebSocket messages in `audioMessages.js`. Frontend reuses
`handleDataReceived` and `handleChunksReceived` unchanged.

### Completion event

```
data: {"type":"done","conversation_id":"abc-123","node_count":12}
```

### Error events

```
data: {"type":"processing_status","level":"error","message":"STT provider unreachable","context":{"stage":"transcribe"}}
```

On unrecoverable error, stream closes after the error event.

### Body size errors

If file exceeds `MAX_BODY_BYTES`, the middleware returns 413 before the
endpoint runs. Frontend should handle 413 with a user-facing message:
"File too large (max 50 MB)".

## Backend Processing Pipeline

```
File received
    |
    v
Detect type (extension + source_type param)
    |
    +-- audio --> save to temp --> call HTTP STT provider --> transcript text
    +-- text  --> read file contents --> transcript text
    +-- vtt/srt --> parse timestamps + text --> transcript text
    +-- google_meet --> reuse import_api parser --> transcript text
    |
    v
sliding_window_chunking(transcript_text) --> chunk_dict
    |
    v
For each chunk:
    TranscriptProcessor.handle_final_text(chunk_text)
        --> generate_lct_json() (LLM call)
        --> SSE: existing_json + chunk_dict events
    Check request.is_disconnected() --> abort if client gone
    |
    v
TranscriptProcessor.flush()
    |
    v
SSE: done event
```

### Audio transcription

For audio files, the backend sends the entire file to the HTTP STT provider
(same endpoint used by `RealtimeHttpSttSession`). This is a single POST
with the audio file, not streaming chunks.

If the audio is long (>5 min), consider splitting into segments and
transcribing in parallel. MVP: single POST, let STT provider handle it.

## Frontend

### Upload button

Small upload icon next to the mic button in the audio footer on `/new`.
Click opens native file picker. Accepts audio + text extensions.

When a file is being processed, the mic button is disabled (can't record
and upload simultaneously).

### Progress indicator

A thin horizontal bar above the footer (or inline text) showing:
- Current stage name
- Real counter (e.g., "Analyzing chunk 2 of 5...")
- Indeterminate pulse during transcription (we don't know duration)

### Data flow

```
FileUpload component
    |
    fetch("/api/import/process-file", { body: formData, signal: abortController.signal })
    |
    response.body.getReader()
    |
    Parse SSE frames (split on \n\n boundaries)
    |
    For each frame:
        JSON.parse(data)
        |
        +-- type=existing_json  --> onDataReceived(data)  [existing handler]
        +-- type=chunk_dict     --> onChunksReceived(data) [existing handler]
        +-- type=processing_status --> update progress UI
        +-- type=done           --> set upload complete state
```

### Cancel

Upload button becomes a cancel button during processing.
Click creates `abortController.abort()`. Backend detects disconnect
via `request.is_disconnected()` in the stream loop.

## Files

| File | Action | LOC est |
|------|--------|---------|
| `lct_python_backend/import_api.py` | **Modify** — add `process_file` endpoint | ~100 |
| `lct_python_backend/services/file_transcriber.py` | **New** — audio→text, text/vtt/srt parsers | ~120 |
| `lct_app/src/components/FileUpload.jsx` | **New** — upload button, progress, fetch+SSE | ~130 |
| `lct_app/src/pages/NewConversation.jsx` | **Modify** — wire FileUpload | ~15 |

**Total: ~365 LOC new code.**

## What's NOT included (YAGNI)

- No drag-and-drop (file picker only for MVP)
- No multi-file / batch upload
- No audio format conversion (rely on STT provider)
- No job queue / background workers
- No audio playback of uploaded file
- No retry on partial failure

## Fallback

If SSE stream parsing proves flaky, switch to NDJSON over chunked fetch
(one JSON object per `\n`-delimited line, same payload contract).
