# Sites Worker compatibility slice

Run `npm run build:sites-worker` from lct_app to create dist/server/index.js.
The bundle exposes the Cloudflare Worker fetch interface using Web APIs only.
The normal `npm run build` and Vercel default handlers remain available.

Implemented endpoints:

- POST /api/proxy/chat: forwards a visitor's own API key and streams the response.
- POST /api/proxy/realtime-token: preserves the existing ephemeral-token request.
- OPTIONS for these endpoints: preserves the existing request guards, and accepts the exact Site request origin.

The adapter uses Cloudflare's ingress client-IP header for the existing approximate per-isolate limit. API replies are not cacheable. It never reads an owner trial key, persists request data, or logs credentials/payloads. BYOK audio-file transcription remains browser-to-OpenAI.

Frontend requests need an ASSETS binding. The adapter reports full-backend endpoints as unavailable; it does not impersonate the Python health endpoint. The original Worker-only slice was not deployable by itself. The complete public journey still needs live-microphone integration and saved-graph navigation before switching the public domain; the parallel checkpoint below adds its separate build and Site identity.

No new packages, database, storage bucket, credentials, public access, or paid inference are configured here. See ../../docs/plans/2026-10-01-lct-sites-migration.md for the delivery sequence and ../tests/intent/sites-serverless-worker.md for validation intent.

## Parallel Site build and identity checkpoint

`npm run build:sites` builds the React frontend into `dist/client` and the Worker into `dist/server/index.js`. The dedicated frontend config reads no environment files or ambient VITE variables, copies no public directory, and adds only the existing favicon. Both output directories are checked before publication. This prevents unrelated public experiments/ciphertexts and owner configuration from entering the artifact. Existing local/Vercel builds are preserved.

`node sites/export-source.mjs ABSOLUTE_EMPTY_DIRECTORY` exports a bounded technical source tree for the standalone Sites source repository. It excludes Git history, environment files, operational documents, tests/fixtures and unrelated static artifacts; symlinks and nonempty destinations are rejected. Initialize the retained template using the Sites project setup helper, then register once and persist the returned project ID. The canonical identity is in `../.openai/hosting.json`; reuse it on continuation.

`GET /api/auth/session` reports the dispatch-provided Site-specific user ID with `no-store`, or returns401 and the dispatch-owned sign-in path when identity is absent. It returns no email or service credential. A service access token cannot replace user identity. This app relies on Sites dispatch to validate identity and strip spoofed caller identity headers; local header fixtures do not prove that deployment boundary. Actual signed-in access must be verified before claiming native sign-in complete.

Browser HTML navigation to an unrecognized asset path falls back to the app shell for React Router deep links. Missing asset files and unsupported backend API routes preserve errors. Sites dispatch owns sign-in, sign-out and callback routes; no app-owned OAuth implementation is added.

The user selected public access for this parallel preview. The Sites build defines its own literal mode flag: Home and browser-local browsing load without a backend health probe, key prompt or login. An optional session panel uses the actual Worker response contract; sign-in/sign-out use top-level dispatch links. Session checking never blocks public content, records at most eight payload-free timing samples, shows elapsed time with unknown remaining time, and supports timeout/retry/cancellation. It neither displays nor persists the user ID.

Public cloud sharing and private cloud storage remain unimplemented; opening a browser-local file does not publish it. Future public saves must label visibility explicitly, while every private storage route must authorize the trusted signed-in owner server-side. Live recording, Soniox and cloud graph reads still require subsequent roadmap stages; do not change the public custom domain or enable owner-funded traffic from this artifact alone.
