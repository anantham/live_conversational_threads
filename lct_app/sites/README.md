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

Browser HTML navigation to an unrecognized asset path falls back to the app shell for React Router deep links, including a managed-asset redirect to the same-origin canonical root. Auth, external and query redirects retain their response; missing asset files and unsupported backend API routes preserve errors. Sites dispatch owns sign-in, sign-out and callback routes; no app-owned OAuth implementation is added.

The user selected public access for this parallel preview. The Sites build defines its own literal mode flag: Home and browser-local browsing load without a backend health probe, key prompt or login. An optional session panel uses the actual Worker response contract; sign-in/sign-out use top-level dispatch links. Session checking never blocks public content, records at most eight payload-free timing samples, shows elapsed time with unknown remaining time, and supports timeout/retry/cancellation. It neither displays nor persists the user ID.

Public cloud sharing and private cloud storage remain unimplemented; opening a browser-local file does not publish it. Future public saves must label visibility explicitly, while every private storage route must authorize the trusted signed-in owner server-side. Live recording, Soniox and cloud graph reads still require subsequent roadmap stages; do not change the public custom domain or enable owner-funded traffic from this artifact alone.

Sites Browse mounts only its browser-local library at this checkpoint. It does not mount the legacy owner audio/server-history sections or request their records. Those sections remain available in the original local/Vercel builds.

## Prepared OpenRouter generation — 2026-10-03

GET /api/cloud/openrouter/status separates configuration/schema readiness from current admission availability. POST /api/cloud/openrouter/generate requires exact Site Origin, application/json, x-lct-openrouter-consent: generate-v1 and a source object accepted by createRecordingTranscript. It returns request_id and a validated artifact; it never saves or publishes source/results. No model, credential or limit submitted by the browser controls the provider request.

No runtime default enables this route. Activation requires explicit LCT_OPENROUTER_ENABLED=true, LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED=true, server-only OPENROUTER_API_KEY, LCT_OPENROUTER_MODEL, LCT_OPENROUTER_PROVIDER, LCT_OPENROUTER_DATA_COLLECTION (allow/deny), LCT_OPENROUTER_AUDIENCE (public/authenticated), LCT_OPENROUTER_MAX_REQUESTS (1..200), LCT_OPENROUTER_MAX_OUTPUT_TOKENS (1..8192), DB and generated migration0006. Do not enable until the exact model/provider/data policy and dedicated non-resetting key allowance are approved and verified. Request/token caps alone are not a dollar ceiling.

Only random IDs/times/token caps/confirmed completion times are retained in lct_openrouter_attempts. Lifetime counts persist; at most2 unresolved attempts and10seconds between admissions. Unknown failures retain their slots; there is no automatic retry/refund/reset. Input arrival is bounded to30seconds/512KiB, provider completion to60seconds/2MiB. Error bodies exclude raw provider details and keys. Delivered abort signals propagate and clean up readers; native client-disconnect delivery needs Cloudflare enable_request_signal and remains a later hosted check. This prepared source has not activated paid traffic or changed the current Site.
