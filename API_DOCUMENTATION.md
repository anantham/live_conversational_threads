# API Documentation

Current backend API reference for Live Conversational Threads.

- Base URL: `http://localhost:8000`
- Interactive docs:
  - Swagger: `http://localhost:8000/docs`
  - ReDoc: `http://localhost:8000/redoc`

Source of truth is the mounted FastAPI routers in `lct_python_backend/backend.py`.

## Auth and Security

- HTTP auth is optional and environment-driven:
  - If `AUTH_TOKEN` is unset, requests are unauthenticated in local dev.
  - If `AUTH_TOKEN` is set, non-health endpoints require `Authorization: Bearer <token>`.
- WebSocket auth uses `?token=<AUTH_TOKEN>` when token auth is enabled.
- Rate limiting and body-size limits are enabled in middleware and configurable via env vars.

## WebSocket Endpoints

### `WS /ws/transcripts`

Primary realtime endpoint for audio-to-transcript-to-graph flow.

Typical message sequence:
1. Client connects to `/ws/transcripts`.
2. Client sends `session_meta`.
3. Client streams `audio_chunk` payloads.
4. Server emits transcript and graph updates:
   - `transcript_partial`
   - `transcript_final`
   - `existing_json`
   - `chunk_dict`
   - `processing_status`
5. Client sends `final_flush` before close.

### `GET /ws/audio` (legacy)

Deprecated compatibility endpoint; returns HTTP `410` with guidance to use `/ws/transcripts`.

## Core REST Endpoints

### Import

- `GET /api/import/health`
- `POST /api/import/google-meet`
- `POST /api/import/google-meet/preview`
- `POST /api/import/from-url` (env-gated by `ENABLE_URL_IMPORT`)
- `POST /api/import/from-text`

### Conversations and Persistence

- `GET /conversations/`
- `GET /conversations/{conversation_id}`
- `DELETE /conversations/{conversation_id}`
- `POST /save_json/`
- `POST /get_chunks/`
- `POST /generate-context-stream/`
- `POST /generate_formalism/`

### STT + LLM Settings

- `GET /api/settings/stt`
- `PUT /api/settings/stt`
- `GET /api/settings/stt/telemetry`
- `POST /api/settings/stt/health-check`
- `GET /api/settings/llm`
- `PUT /api/settings/llm`
- `GET /api/settings/llm/models`

### Graph + Thematic

- `GET /api/graph/health`
- `POST /api/graph/generate`
- `GET /api/graph/{conversation_id}`
- `GET /api/graph/{conversation_id}/nodes`
- `GET /api/graph/{conversation_id}/edges`
- `DELETE /api/graph/{conversation_id}`
- `POST /api/conversations/{conversation_id}/themes/generate`
- `GET /api/conversations/{conversation_id}/themes`
- `GET /api/conversations/{conversation_id}/themes/levels`

### Analysis

- `POST /api/conversations/{conversation_id}/simulacra/analyze`
- `GET /api/conversations/{conversation_id}/simulacra`
- `POST /api/conversations/{conversation_id}/biases/analyze`
- `GET /api/conversations/{conversation_id}/biases`
- `POST /api/conversations/{conversation_id}/frames/analyze`
- `GET /api/conversations/{conversation_id}/frames`

### Analytics and Bookmarks

- `GET /api/analytics/conversations/{conversation_id}/analytics`
- `GET /api/analytics/conversations/{conversation_id}/timeline`
- `GET /api/analytics/conversations/{conversation_id}/roles`
- `POST /api/bookmarks`
- `GET /api/bookmarks`
- `PATCH /api/bookmarks/{bookmark_id}`
- `DELETE /api/bookmarks/{bookmark_id}`

### Prompt Management

- `GET /api/prompts`
- `GET /api/prompts/config`
- `GET /api/prompts/{prompt_name}`
- `PUT /api/prompts/{prompt_name}`
- `POST /api/prompts/{prompt_name}/validate`
- `POST /api/prompts/reload`

## Notes

- Some routes return legacy payload shapes for compatibility with existing frontend flows.
- `POST /save_json/` currently writes through the GCS helper path; in local environments without configured ADC/bucket, this endpoint can return a 500 until cloud credentials are configured.
- For latest request/response schemas, use Swagger (`/docs`) because those are generated from current Pydantic models and router signatures.
