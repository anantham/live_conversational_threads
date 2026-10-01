# Sites Worker compatibility slice

Run `npm run build:sites-worker` from lct_app to create dist/server/index.js.
The bundle exposes the Cloudflare Worker fetch interface using Web APIs only.
The normal `npm run build` and Vercel default handlers remain available.

Implemented endpoints:

- POST /api/proxy/chat: forwards a visitor's own API key and streams the response.
- POST /api/proxy/realtime-token: preserves the existing ephemeral-token request.
- OPTIONS for these endpoints: preserves the existing request guards, and accepts the exact Site request origin.

The adapter uses Cloudflare's ingress client-IP header for the existing approximate per-isolate limit. API replies are not cacheable. It never reads an owner trial key, persists request data, or logs credentials/payloads. BYOK audio-file transcription remains browser-to-OpenAI.

Frontend requests need an ASSETS binding. The artifact deliberately reports full-backend endpoints as unavailable; it does not impersonate the Python health endpoint. A complete frontend build, asset wiring, live-microphone integration and saved-graph navigation must pass before publishing or switching the public domain. This source slice has no Site ID and is not deployable by itself.

No new packages, database, storage bucket, credentials, public access, or paid inference are configured here. See ../../docs/plans/2026-10-01-lct-sites-migration.md for the delivery sequence and ../tests/intent/sites-serverless-worker.md for validation intent.
