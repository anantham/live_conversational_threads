# Same-check OpenRouter account balance — 17 October 2026

User requests balance lookup in the existing indicator check. The existing
restricted inference key is reused for fixed /key and /credits GETs, no new key,
management privilege, paid inference or reservation mutation. Financial totals,
usage, labels and credentials remain server-side; public output is coarse only.
Credits have a2.5second child deadline inside the existing6second key check, body
limit8192bytes and redirect refusal. Refusal/malformed/timeout preserve completed
key reachability; actual exhausted account forces exhausted allowance. Existing
60second single-flight cache and local-capacity gate remain.

Twenty focused tests pass. Full1060/1060 across122files pass with
NODE_OPTIONS=--no-experimental-webstorage on the installed Node26.0.0. Initial
unflagged full run failed155 tests in15files at setup because the Node Web Storage
global shadowed jsdom localStorage without a backing file. The same unchanged10
PrivateFiles tests pass under the compatibility flag, then the complete suite
passes; no product/test oracle was changed. Track Node toolchain compatibility
separately rather than patch storage to satisfy a runner mismatch.

Independent family: Google Gemini, gemini-4-argon-medium via existing authenticated
AGY subscription, fresh plan/read-only conversation. Public files only:
serviceHealth.js,openRouterIO.js,ConversationServiceStatus.jsx and its test,
sitesServiceHealth.test.js,tests/intent/sites-conversation-controls.md. No runtime
files/logs, account identifiers, keys, private transcripts or records were sent.
Packet33566bytes/SHA2563fa6c26d8216548dcb07ef65d331b7a3600ebedd41b6139de171f6d0c71ffe15.
Conversationa0154119-f0d2-4d08-802e-b6cd01780b91; SUCCESS/PASS,17.074s,one turn,
no findings. Practical no-tools request and plan mode used; no exhaustive client
isolation claim. Official API reference confirms management permission required:
https://openrouter.ai/docs/api/api-reference/credits/get-credits

Source validated and native build/package underway, not yet served. Actual live
balance outcome and source/deployment identities will be appended after publication.
