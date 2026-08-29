# ISSUES

Last updated: 2026-08-29

## 2026-08-29 — Backendless Browse reports expected history absence as console.error (OPEN, NON-BLOCKING)

**Summary:** The local-first `/browse` route remains usable when the private
history backend is absent, but its expected server-history probe rejection is
reported with `console.error` as `[Browse] Server history unavailable`.

**Impact:** Low product impact, medium audit noise. Local artifacts still open
and remain private, but a strict browser-console gate cannot distinguish this
expected capability absence from a genuine page failure without an allow-list.

**Blocker status:** Non-blocking for the mobile Drive viewer gate. The mobile
journey asserts zero unexpected console problems and zero network 5xx while
allowing this one known backendless diagnostic.

**Recommended next step:** Model backendless history as an explicit capability
state and log it at info/debug level; reserve `console.error` for a server that
was configured and then failed unexpectedly.

## 2026-08-28 — Live smoke searched speaker legend instead of conversation cards (REPAIRED)

**Summary:** The deployment-triggered production smoke for merge commit
`5b673f0` failed because `getByText('Speaker One')` searched the entire DOM.
The speaker-colour legend intentionally retains participant names, including
while its Display disclosure is closed. The rendered conversation card itself
contained only coloured turn markers and utterance text, which is the actual
product contract the test intended to protect.

**Impact:** The production viewer was healthy and seven of eight live smoke
journeys passed, but the false-positive assertion made the release signal red.
It could also encourage removing useful legend information to satisfy a test
whose scope contradicted its stated intent.

**Blocker status:** Repaired in the smoke harness. This was blocking truthful
post-deploy verification, not a production rendering defect.

**Resolution:** Scope the no-visible-speaker-name assertion to
`.lct-conversation-node`, explicitly assert that the fixture's three cards and
scoped utterance rendered, and keep the separate `data-speaker-id` assertion.
The speaker-colour semantics therefore remain machine-verifiable without
rendering the participant name inside a turn summary.

**Recommended next step:** Run the focused assertion and complete production
suite against the live domain, independently review the exact test/docs diff,
then ship and require the deployment-triggered smoke to return green.

## 2026-08-27 — Vercel preview protection blocks anonymous browser smoke (OPEN, NON-BLOCKING)

**Summary:** PR preview deployments redirect an unauthenticated Playwright
browser to Vercel's own login screen. The deployment check succeeds, but a
direct post-deploy browser run cannot reach LCT without a Vercel protection
bypass or authenticated browser state.

**Impact:** Low. Local production-mode browser coverage proves the cached Drive
reopen behavior, and the public production smoke remains the authoritative
post-merge check. Preview URLs cannot currently provide anonymous end-to-end
evidence before merge.

**Blocker status:** Non-blocking for PR #178; Vercel deployment passed and all
local unit, build, lint, and browser gates are green.

**Recommended next step:** Configure a CI-only Vercel protection bypass secret
for preview Playwright, or deliberately keep preview protection and document
that live browser verification occurs after merge on the public domain.

## 2026-08-26 — Drive-backed viewer needs a Google Web OAuth client

**Summary:** The recipient-side `driveFile` opener is implemented and tested,
but the existing `bold-rain-455402-b9` credential is an installed/desktop OAuth
client. Google Identity Services in a browser requires a Web application client
from the same project with `https://threads.adityaarpitha.com` registered as an
authorized JavaScript origin. No compatible client id is configured in Vercel.

**Impact:** Local file opening and Browser Library remain fully functional. A
deployed `/view?driveFile=...` link will explain that Drive-backed opening is not
configured instead of launching OAuth until `VITE_GOOGLE_DRIVE_CLIENT_ID` is set.

**Blocker status:** Blocks live end-to-end recipient validation and production
activation of the new one-click link; does not block merging the fail-closed
code path.

**Recommended next step:** Sign into Google Cloud project
`bold-rain-455402-b9`, create/locate a Web OAuth client with the production and
local authorized JavaScript origins documented in
`docs/DRIVE_BACKED_THREADS.md`, add its public client id to Vercel as
`VITE_GOOGLE_DRIVE_CLIENT_ID`, redeploy, and test with a Drive-reader account.

## 2026-08-25 — Repository-wide ESLint baseline is red (OPEN, NON-BLOCKING)

**Summary:** `npm run lint -- --quiet` reports 109 errors across pre-existing,
untouched frontend, API-proxy, test, and configuration files. The files changed
for PR #175 pass a scoped ESLint invocation with zero findings.

**Impact:** Medium engineering friction. A repository-wide lint gate cannot
currently distinguish a new lint regression from the historical baseline.

**Blocker status:** Non-blocking for PR #175 because every touched JavaScript
file passes scoped lint and the full frontend unit suite and production build
are green.

**Recommended next step:** Establish and ratchet a zero-new-errors lint baseline,
then pay down existing groups by runtime domain rather than mixing them into an
unrelated viewer repair.

## 2026-08-25 — Worktree Fontsource assets rejected by Vite dev allow-list (OPEN, NON-BLOCKING)

**Summary:** Local Playwright runs from the nested git worktree log Vite
allow-list warnings for Fontsource files resolved through the main checkout's
shared `node_modules`. The production build resolves and embeds the same fonts.

**Impact:** Low and local-development-only. Browser behavior tests pass, but
screenshots from this worktree may render fallback fonts.

**Blocker status:** Non-blocking for PR #175; it does not occur in the built
artifact and is unrelated to the changed viewer semantics.

**Recommended next step:** Give each worktree its own dependency install or add
the resolved shared dependency directory to Vite's development-only allow-list.

## 2026-08-25 — Overview-collapse browser assertion contradicted compact-header behavior (REPAIRED LOCALLY)

**Summary:** The existing `.threads` opener browser journey expects the
conversation title heading to disappear after activating “Hide conversation
overview.” The product correctly switches the control to “Show conversation
overview” but retains the title in the compact persistent header, so the stale
heading-count assertion fails reproducibly.

**Impact:** Low and test-only. The overview control changes state and the viewer
remains usable; this does not affect the NodeDetail focus or Library accessible-
name repairs. The focused regression for the latter passes.

**Blocker status:** Repaired locally; exact-head independent review and remote CI
remain before merge.

**Resolution:** The browser contract now asserts that overview-only content
collapses while the persistent title and navigation remain visible. The same
journey also checks that the animated timeline collapses to zero height and is
inert without requiring its mounted descendants to disappear from the DOM.

**Recommended next step:** Keep the compact-header behavior covered in the
cross-viewport viewer suite.

## 2026-08-24 — Partial optional hierarchy tier aborted valid lower graph (REPAIRED LOCALLY)

**Summary:** A non-empty arc result that omitted one or more themes reached the
strict hierarchy synchronizer outside the consolidation exception boundary.
The resulting L4→L5 orphan error prevented persistence of an otherwise complete
and auditable lower hierarchy.

**Impact:** High before repair. One imperfect optional model response could
discard the useful L1-L4 result after all transcript and model work completed.

**Blocker status:** Repaired locally; the new exact head still requires a fresh
independent review and remote CI before merge.

**Resolution:** Arc consolidation now adopts omitted themes consistently with
the lower consolidators. A shared best-effort synchronization boundary also
drops any incomplete optional tier and higher tiers while preserving the
highest complete prefix. L1-L2 orphaning still fails hard. The actual persisted
repair path, all affected consumers, and real Postgres have behavioral coverage.

**Recommended next step:** Push the follow-up commit, re-review its exact SHA,
and let the fail-closed merge wrapper proceed only with zero findings.

## 2026-08-24 — Grok local hooks and timeout enforcement need repair (OPEN, NON-BLOCKING)

**Summary:** The second Grok review was slowed by global hooks pointing to the
invalid Windows path `/c/Users/adity/anaconda3/python.exe`. The repository
wrapper also accepts `TimeoutMinutes` for Grok but does not currently enforce a
process timeout.

**Impact:** Medium operationally, no review-integrity impact. Hook failures are
explicit and fail open inside Grok; the repository gate still fails closed on
missing/invalid results. A stalled service could nevertheless hold the wrapper
longer than its advertised timeout.

**Blocker status:** Not blocking PR #172 because the review completed with a
parsed result. Out of scope for the hierarchy repair.

**Recommended next step:** Correct the global Grok hook interpreter path and
enforce `TimeoutMinutes` around the Grok child process with stdout/stderr
capture preserved.

## 2026-08-24 — PR #172 independent-review hierarchy findings (REPAIRED LOCALLY)

**Summary:** Independent Grok review found that membership synchronization could
silently select the wrong relationship persistence lane, persisted hierarchy
repair did not reapply the conversation's ADR-063 provider permissions, and the
repair path required unjustified upper tiers for short conversations.

**Impact:** High before repair. The first bug could omit authored temporal and
argument edges, the second could send transcript-derived graph text to an
external provider despite private-only consent, and the third discarded valid
L1-L2 repair work.

**Blocker status:** Repaired locally with behavior tests; fresh independent
review and remote CI are required before merge.

**Resolution:** Hierarchy synchronization now preserves an all-legacy or
all-faithful edge contract and refuses mixed inputs. Persisted repair uses the
same fail-closed privacy/provider selector as initial extraction. Topic, theme,
and arc generation use standard thresholds and remain optional above a durable
L1-L2 repair. Focused, broader, and real-Postgres suites pass.

**Recommended next step:** Push the repair, run Grok against the exact new head,
and merge only if the parsed review has zero findings and every required GitHub
check is green.

## 2026-08-24 — Grok review wrapper mixed diagnostics with JSON (REPAIRED LOCALLY)

**Summary:** The independent-review script redirected stderr into stdout and
then parsed the combined stream as JSON. Grok also returns the requested schema
inside an outer `structuredOutput` envelope. A valid review therefore failed
closed as an unparseable result.

**Impact:** Medium operationally. The gate remained safe, but it could not
distinguish a real review finding from transport telemetry and blocked an
otherwise actionable review.

**Blocker status:** Repaired locally; the next live Grok review is the behavioral
acceptance test.

**Resolution:** Stdout is stored and parsed independently, stderr is retained as
a separate diagnostic artifact, and `structuredOutput` is unwrapped before the
verdict/findings schema is evaluated. Unknown shapes and command failures still
fail closed.

**Recommended next step:** Require the repaired wrapper to produce a parsed,
head-SHA-bound zero-finding artifact before invoking the merge wrapper.

## 2026-08-23 — Postgres integration gate lacks privacy-aware fixtures and shares async loops (REPAIRED LOCALLY)

**Summary:** PR #172's real-Postgres job failed identically on its initial run
and one rerun: 51 tests pass, while the two Phase-2 extraction tests configure
`load_llm_providers()` as an empty list after ADR-063 made provider trust
fail-closed, and the final import-turns HTTP test creates a fresh `TestClient`
whose event loop reuses a global async database engine bound by earlier tests.
The failures are outside the frontend-only Browse diff. PR #171 passed before
merge, but its resulting `main` combines these newer privacy/test-harness paths.

**Impact:** High CI reliability, low immediate product impact. Correct frontend
PRs cannot reach a green required-check state. The privacy failure is a stale
fake, not evidence that production policy should be weakened; the different-loop
500 masked the endpoint's actual ADR-063 raw-retention behavior.

**Blocker status:** Resolved. The fixture repair passed the complete 55-test
real-Postgres gate locally and PR #172's remote Linux job. It does not invalidate the
Browse provider, drag/drop, or offline-entry behavior, whose unit, browser,
build, preview, and Vercel checks pass.

**Resolution:** The Phase-2 fake now returns one explicitly trusted
`owner_private` loopback provider, supplies explicit local-only consent, and
stubs the unrelated hierarchy/edge model stages with valid deterministic
results. The endpoint module now uses one context-managed `TestClient` and
disposes its async pool before that portal loop closes. Once the masked request
completed normally, it also proved the old expected 400 contradicted ADR-063:
the integration boundary now asserts 200 for `personal_private` and 400 for
`hosted_shared`, even when the retired `LCT_MIRROR_RAW` flag is set. Production
privacy behavior was not changed.

**Recommended next step:** Keep the real-Postgres job required on future PRs so
privacy-aware fixtures and async loop ownership remain continuously exercised.

## 2026-08-15 — Provider trust classification has no dedicated settings control

**Summary:** ADR-063 now enforces an explicit `owner_private` / `external`
trust scope for every graph-generation provider. The authenticated settings API
persists the field, and missing or invalid values fail closed as `external`, but
the provider editor does not yet expose a dedicated trust-scope control.

**Impact:** Safe but operationally awkward. New/custom local providers cannot
process private-only meetings until an operator classifies them through the API
or configuration. Existing records are not silently trusted based on their URL.

**Blocker status:** Not blocking the approved owner-operated MVP; the two known
local routes can be explicitly classified before replay. It is a blocker for a
non-technical operator adding another private provider through the UI.

**Recommended next step:** Add a clearly explained deployment-boundary selector
to `LlmProvidersPanel.jsx`, display the effective trust scope in provider cards,
and behavior-test that a missing choice defaults to external.

## 2026-07-03 - Backend catalog selected/effective LLM unit test is red on dirty checkout

**Summary:** While validating route diagnostics for the IndrasNet/LCT supervisor
investigation, the broader focused backend test batch surfaced
`lct_python_backend/tests/unit/test_backend_catalog.py::test_llm_selected_vs_effective_differ_when_providers_override`.
The test expected `cat["active"]["llm"] == "local-ollama"` while the current
checkout returns `tailscale-rtx-llm`.

**Impact:** Medium diagnosability/product-risk. This may mean the settings UI can
blur the distinction between the configured selected LLM and the currently
effective provider override. It also prevents using the backend-catalog unit
suite as a clean validation gate for unrelated instrumentation.

**Blocker status:** Not blocking the current route-diagnostic instrumentation.
The failure is in the pure `build_catalog(...)` unit path, not in the route
wrappers or request-timing helpers.

**Recommended next step:** Inspect recent changes around
`lct_python_backend/services/backend_catalog.py` and
`lct_python_backend/tests/unit/test_backend_catalog.py`; decide whether selected
LLM should remain config-driven while effective LLM reflects provider priority,
then update code or test intent accordingly.

## 2026-07-01 — SSRF: resolve-then-connect DNS-rebind TOCTOU in URL/gdoc fetchers (KNOWN RESIDUAL, deferred)

**Summary:** Surfaced by an adversarial SSRF review of the gdoc-egress fetcher (PR #140,
ADR-059 PR-2 core). Both URL-import fetchers validate the target host by resolving DNS and
rejecting internal IPs, then let `httpx` open the connection — which **re-resolves DNS at
connect time**. A poisoned/rebinding resolver (or short-TTL flip) can return a public IP at
check time and an internal IP (loopback / RFC1918 / `169.254.169.254` IMDS) at connect time
— the classic resolve-then-connect SSRF bypass.

- `services/import_pipeline/import_fetchers.py::download_url_text` (pre-existing).
- `services/import_pipeline/import_fetchers.py::download_gdoc_text` (added in #140).

Both call `assert_url_resolves_to_public_host(url)` (`import_validation.py`), a resolve-once check.

**Why deferred (not a blocker):** Not a regression — `download_url_text` shipped with this
pattern and is gated behind `ENABLE_URL_IMPORT` (default off). `download_gdoc_text`
additionally restricts to a `docs.google.com` / `*.googleusercontent.com` allowlist +
https-only + per-hop re-validation, so an attacker would need to control DNS for Google's
own domains.

**Fix (shared, both fetchers):** Pin the validated IP into the connection so check-time and
connect-time addresses can't diverge — a custom `httpx` transport/resolver that resolves
once, validates every returned address is public, and connects to the pinned IP with the
correct `Host` header + TLS SNI. Apply on every redirect hop. Acceptance: a rebinding test
(public IP at check, `127.0.0.1` / `169.254.169.254` at connect) → fetch refused; no behavior
change for legitimate public hosts or the gdoc export redirect chain.

cf ADR-059 (gdoc double-block), ADR-034 (egress chokepoint), `import_validation.assert_url_resolves_to_public_host`.

## 2026-06-20 — Auth-reject CORS masking + cold-start gate false-negative + retry storm (FIXED 2026-06-23)

**Summary:** Surfaced during the 2026-06-17→19 public-deploy token-mismatch incident
(see `docs/HANDOVER_2026-06-19_public-deploy-token-incident.md`). Three pre-existing
defects that together made a simple auth failure look like a total outage and made it
hard to diagnose. All three FIXED 2026-06-23 (commits below) — the two frontend fixes
reach the live site on the next Vercel rebuild, the backend fix on the next backend restart.

- **Auth-reject responses lack CORS headers → browser shows a misleading "CORS /
  backend unreachable" instead of "401 Unauthorized" (HIGH for diagnosability).**
  The bearer-auth middleware returned 401 *inside* `CORSMiddleware`, so the reject
  response carried no `Access-Control-Allow-Origin`; the browser reported "blocked by
  CORS policy", hiding the real 401 — this is exactly why the token mismatch presented
  as "backend unreachable" with ~185 console CORS errors. **FIXED (`87dec79`):** made
  `CORSMiddleware` the outermost middleware (added last in `backend.py`, after
  `configure_p0_security`) so 401/429/413 rejects flow back out through CORS and carry
  the header. `tests/unit/test_cors_on_error.py` locks in the behaviour + that a
  disallowed origin still gets no header.
- **Cold-start gate false-negative.** First load showed "Private Beta — backend
  unreachable" because the health probe timed out on the cold tailnet (DERP)
  handshake; it succeeds on retry once the path is warm (~50ms). **FIXED (`c440963`):**
  `App.jsx probeBackend` now retries up to 3× — a generous 12s first timeout for the
  cold handshake, then two short backoff retries — before showing the BetaGate.
- **Retry storm (no backoff).** Once auth failed, the frontend fired ~185 failed
  fetches with no backoff. **FIXED (`281d688` + `87dec79`):** a fetch-layer circuit
  breaker in `apiClient.js` — after 4 consecutive failures it fails fast for a 10s
  cooldown; it counts both "failed to fetch" (network-down / CORS-masked 401) and, now
  that 401s are readable, consecutive 401s.

## 2026-06-20 — Feature request: meeting bot session metadata capture

**Summary:** For every meeting the Attendee bot joins, persist structured session
metadata alongside transcript events: attendee roster, available participant
identity/email, join/leave timestamps, bot lifecycle events, recording permission
events, and low-rate screenshot/video samples or derived video-state metadata when
the consent/privacy policy allows it.

**Impact:** Medium/high product value for the live conversation tree. This gives
future summaries, branches, and evidence views provenance beyond text alone, but
it also touches sensitive identity and visual data, so retention, redaction,
local-only storage defaults, and explicit UI affordances need an ADR before
implementation.

**Blocker status:** Not blocking the current live subtitle overlay debug path.

**Recommended next step:** Add an ADR for meeting capture metadata scope and
retention, then implement a narrow first slice that records bot lifecycle,
attendee roster snapshots, identity fields provided by Attendee/Google Meet, and
timestamps before adding any video-frame sampling.

## 2026-06-14 — Diagnostic logging leaked conversation content to console/logs (FIXED 2026-06-14)

**Summary:** A multi-agent + `codex exec` audit of the diagnostic-logging surface
found that several ungated logs echoed private conversation content — counter to
the privacy-first posture and AGENTS.md #9 (diagnostic logging must be gated,
default OFF, opt-in; genuine failures stay loud). Confirmed leaks, all fixed on
`fix/logging-privacy`:

- **Contact PII (frontend, HIGH).** `useTranscriptSockets.logToServer` did an
  unconditional `console.log("[Client Log]", text)`. `audioMessages.js` routes
  contact `display_name`, `matched_phrase`, and `speaker_ids` through it →
  contact identity + matched conversation phrases hit the browser console on
  every consumption match. Fix: gate behind `makeDebug("stt")` (the WS send to
  the backend is unchanged).
- **Raw WS frame (frontend).** `audioMessages.js` catch logged `event?.data` —
  the raw backend frame carries transcript text / node content. Fix: log the
  parse error only.
- **Raw response body (frontend).** `SaveConversation.jsx` logged the raw
  non-JSON response `text` (can echo saved conversation content). Fix: log a
  static message; the parse failure is the signal.
- **Full data dumps (frontend).** `Bookmarks.jsx` (`Loaded bookmarks:` + full
  response), `ImportCanvas.jsx` (`Canvas imported successfully:` + result),
  `useFileUploadStream.js` (STT `stt_http_url` topology + full `telemetry`
  blob), `DualViewCanvas.jsx` (zoom traces). Fix: removed or gated behind
  namespaced `makeDebug`.
- **Transcript preview (backend).** `stt_http_transcriber.py:792,912` logged
  `transcript_preview=%s` at INFO, ungated — while its 5 sibling STT-trace sites
  in the same file gate on `TRACE_API_CALLS`. Fix: gate both.
- **`TRACE_API_CALLS` defaulted ON.** The flag (duplicated across 5 services
  modules: `stt_http_transcriber`, `transcript_llm_callers`,
  `stt_provider_transports`, `local_llm_client`, `llm_gateway`) defaulted to
  `True`, so transcript/LLM-content traces were on by default. Fix: default
  `False` everywhere; set `TRACE_API_CALLS=1` to opt in.
- **`LOG_LEVEL` no-op (backend).** `backend.py` pinned the `lct_python_backend.*`
  package logger to `DEBUG` unconditionally, so `LOG_LEVEL` only affected the
  thin `lct_backend` app logger and every `services/*` DEBUG line was forced into
  the file log regardless. Fix: resolve `LOG_LEVEL` once and honor it for both
  loggers (default INFO → DEBUG diagnostics opt-in).

**New infra:** `lct_app/src/utils/debug.js` — one gated, namespaced frontend
logger (`makeDebug(namespace)`), OFF by default, opt-in via `VITE_LCT_DEBUG`,
`localStorage["lct:debug"]`, or `window.__lctDebug.enable("ns")`. Replaces the
four ad-hoc gates. `vite.config.js` adds defense-in-depth: prod builds mark
`console.log/info/debug` as `pure` (dropped by minification) while keeping
`console.warn`/`console.error` so genuine failures survive. Dead `Input.jsx`
deleted.

**Impact:** Medium. Leaks were to the local browser console and the local
rotating file log (not shipped off-device), so no external exfiltration — but
contact names + conversation phrases in the console violate the local-first
privacy contract and would surface in any screen-share / shared dev session.

**Blocker status:** Not blocking. Shipped on `fix/logging-privacy`.

### Follow-up (2026-06-14) — Error-from-body sweep + logger migration (DONE)

The two follow-ups below were completed in a second pass on the same branch. A
multi-agent discovery + adversarial-review workflow drove both.

**Error-from-body sanitization sweep.** Codex's "~8 sites" estimate was exact for
the *known* set, but the discovery finders surfaced **7 more** raw-body→error/log
sites (≈15 total): frontend `sttSettingsApi.js` (handleResponse, 5 callers),
`speakerNamingApi.js` (also a latent `json()`-then-`text()` double-read bug),
`useFileUploadStream.js:234` (raw body → upload error UI); and backend
`perplexity_factcheck.py:173` + `local_llm_client.py:199/524/739` (raw upstream
provider bodies logged ungated — same class as the STT traces above).
- **Frontend:** new shared `readErrorMessage(response, fallback, {cap})` in
  `apiClient.js`. Prefers the structured FastAPI `{detail}`/`{message}` but caps
  **every** server-controlled return path (the adversarial review caught that an
  early draft left the JSON-detail branch uncapped). Handles the 422 array shape
  `[{loc,msg,type,input}]` by keeping `msg` and **dropping `input`** — `input`
  echoes the submitted payload, which for `byokApi` is the user's **API key**.
  Salvages an HTML `<title>` (proxy 502/504) before capping boilerplate. 10 unit
  tests in `readErrorMessage.test.js` cover the cap, the key-drop, and the
  non-destructive `.clone()` read. All 11 raw-body call sites refactored onto it
  (diagnostics surfaces — ServiceStatus, backend-catalog — pass `cap: 1000`).
- **Backend:** the 4 ungated upstream-body logs now keep the failure **loud**
  (status + provider) but gate the raw body behind `TRACE_API_CALLS` (added the
  flag to `perplexity_factcheck.py`); the LLM-fallback `error_msg` keeps the HTTP
  status always and includes the 100-char body only under the flag.
- **Left as-is (documented):** `SaveConversation.jsx` already reads the body
  defensively without exposing it (earlier fix); the LLM-fallback bodies are
  bounded to 100 chars and gated.

**Logger migration.** `contextualGraphUtils.js` (`VITE_GRAPH_DEBUG`) and
`AudioInput.jsx` (`__LCT_DEBUG_AUDIO`) folded into `makeDebug("graph")` /
`makeDebug("audio")` — zero behaviour change (both were already default-OFF).
`MinimalGraph`'s `__MG_DEBUG__` (named in the original note) does not exist on
this branch — only two genuine `console.warn` persist-failure logs, correctly
left loud.

**`apiClient` API-trace folded in too (per follow-up decision).** `apiClient.js`'s
`TRACE_API` (`VITE_API_TRACE`) previously defaulted to `import.meta.env.DEV`, so
API request lines **and** 500-char response-body previews printed to the console
by default in local dev. It now routes through `makeDebug("api")` — OFF by
default, opt in with `VITE_LCT_DEBUG=api` / `window.__lctDebug.enable("api")` —
and the body preview only computes when the gate is enabled, closing the last
default-on content-to-console path. `LOCAL_SETUP.md` updated accordingly.

## 2026-06-08 — CI: e2e smoke + codex-review red on every PR (test mis-seeding + missing action)

**Summary:** Two PR-gate checks fail on every PR regardless of the change
(surfaced while merging #54; the failing test files + `.github/workflows/e2e.yml`
are byte-identical to `main` — not a regression). (1) `e2e.yml` runs the
"DB-independent" smoke specs against a fresh Postgres (migrations only, no
seeding), but `lct_app/tests/e2e/d4-color-mode-smoke.spec.ts:10` hard-codes
`EXISTING_CONV = '0d6d5d7b-…'` and navigates to `/conversation/<id>` — never
seeded → backend 404 → `.react-flow__node` never renders → 30s timeout.
`lct_app/tests/e2e/initialization.spec.ts:72 › should load without JavaScript
errors` fails on the same backend 404s. (2) `.github/workflows/codex-review.yml`
dies at setup in ~3s: `Unable to resolve action openai/codex-review-action,
repository not found`.

**Impact:** Low but corrosive. Both are **non-required** checks (don't block
merges), but a permanently-red PR gate trains everyone to ignore CI and hides
real regressions. PR #54's e2e run: 2 failed / 5 passed. (GitHub Issues are
disabled on this repo, so logged here per the ISSUES.md convention.)

**Blocker status:** Not blocking (non-required checks; #54 was merged over them
after confirming the failures are pre-existing and unrelated to the branch).

**Recommended next step:** (a) make `d4-color-mode-smoke` self-provision its
conversation via the import/create API in `beforeAll` (the pattern the workflow
header comment says data-dependent specs must follow), or drop it from the
DB-independent smoke list in `e2e.yml`; (b) make `initialization › no JS errors`
tolerant of expected backend 404s on a fresh DB; (c) fix or disable
`codex-review.yml` (pin a real, accessible action).

## 2026-06-01 — Diarization selection saves but doesn't steer the runtime

**Summary:** The "Active engines" Diarization lane (`InferenceLanes.jsx` →
`updateDiarizationSettings`) persists the chosen diarizer (`primary` +
`fallback_priority`) to the DB and reflects it in the catalog/UI, but
`load_diarization_settings` has **no consumer in the live transcription
pipeline** — the saved choice does not change which diarizer actually runs
(the legacy per-provider `diarize_model` path still governs).

**Impact:** Low/cosmetic-but-misleading. The control looks effective; it isn't
yet wired downstream. Honest (no crash, documented here), just inert. Confirmed
by the 2026-06-01 feature-state audit of `feat/e2e-audio-graph-zoom`.

**Blocker status:** Not blocking — surfaced via the lane's "isn't running yet"
override notice. Deferred per maintainer.

**Recommended next step:** wire `load_diarization_settings` into the
transcription pipeline's diarizer selection (or remove the control until it's
consumed). Pairs with the FluidAudio-sidecar-not-bundled gap.

## 2026-06-01 — Active-engines LLM picker: partial-wiring gaps (FIXED 2026-06-01)

Codex re-review of PR #52 (findings D/E/F/G) flagged two LLM-selection gaps in
`InferenceLanes.setLlmPrimary`. Both fixed this session:
- **Gemini switch 400 (D):** switching the LLM lane to Gemini saved `mode=online`
  while keeping the local `chat_model`, which `llm_api.update_llm_settings`
  rejects (validates `chat_model` against the Gemini model list). Fix: resolve a
  real Gemini model (`getLlmModelOptions({mode:'online'})`, fallback
  `gemini-2.5-flash`) and send it on the switch.
- **Local-LLM selection silently overridden (E/F/G):** selecting a local engine
  only sets `llm_config.base_url`, but graph generation runs the first enabled
  `llm_providers` entry — so the choice could be inert. Fix: when the catalog's
  `llm_effective` differs from the selected entry, the save now warns that the
  provider chain governs and must be reordered/disabled (the
  [[lct-llm-config-seam]] divergence, surfaced honestly rather than a false toast).

## 2026-05-31 — Crux detection has no online (Gemini) LLM path

**Summary:** `CruxDetector._detect` routes through `local_chat_json` → the LLM
gateway, which is **openai-compatible only** by design (online/Gemini generation
lives in `transcript_llm_callers`, unreachable from the gateway). So when the LLM
lane is set to online/Gemini mode, crux can't run.

**Impact:** Low. As of 2026-05-31 crux now **fails honestly** — `_detect` raises
`CruxConfigurationError`, which `analyze_conversation` surfaces in the response's
`error` field (HTTP 200) and the crux page renders, telling the user to switch the
LLM lane to a local engine — instead of silently posting to a likely-down local
endpoint. (Found by codex re-review of PR #52, finding B.)

**Blocker status:** Not blocking. Crux works on any local/openai-compatible
provider; only pure online-Gemini mode is unsupported.

**Recommended next step (deferred — out of proportion for this path):** if crux
must run under online-Gemini, add a general Gemini chat-JSON caller (messages in,
JSON out) reusing `_resolve_gemini_api_key` / `_resolve_online_gemini_model` from
`transcript_llm_callers`, and dispatch on `mode=='online'` in `_detect`.

## Rationality features & stubs audit (2026-05-30)

8-agent audit (full report + status table: `docs/AUDIT_RATIONALITY_2026-05-30.md`). Branch `feat/e2e-audio-graph-zoom`. Nothing deleted. Key gaps:

- **[ABSENT] Crux detection.** `is_crux` (`models/graph.py:43`) is a DB boolean **never set True by any code** — yet there is live read-plumbing (`conversation_reader.py:282`, `conversations_api.py:505`) and a dead amber node-styling branch (`MinimalGraph.jsx:218,235`). No `crux_detector.py`, no crux prompt. The "crux" zoom concept is a dead flag.
- **[ABSENT] Double-crux, Ideological Turing Test, steelmanning, devil's-advocate, charitable-interpretation.** No code anywhere — only roadmap docs + a hardcoded "Steelmanning Score: 7/10" mockup (`FEATURE_SIMULACRA_LEVELS.md:762`). "ITT" never appears in the repo.
- **[ABSENT] Cross-speaker agree/disagree map.** Node↔node `agrees`/`disagrees` edges exist + render, but with **no speaker attribution**. "Where does speaker A disagree with speaker B" does not exist; `speaker_analytics.py` does time/turns/roles only. New build.
- **[ORPHANED] Real fact-check verification unreachable.** `POST /fact_check_claims/` (`perplexity_factcheck.py:111` — verdict + citations) is only called by `archive/TranscriptApp.jsx`. The live banner (`openai_factcheck`, `NodeDetail.jsx:285`) is classification only, not verification, and is **not persisted** (`Claim.verification_status` hardcoded `None`; save fn commented out in `db_helpers.py:31`).
- **[ORPHANED] Three detectors built but unlinked in UI.** Bias (`/biases`), Frame (`/frames`), Simulacra (`/simulacra`) have complete backends + pages + routes (`AppRoutes.jsx:33-35`) but **no nav link** — reachable only by typing the URL. Quick win: add links.
- **[ORPHANED] ClaimDetector / ArgumentMapper / IsOughtDetector.** `claim_api.py`/`argument_api.py` define handlers but **no APIRouter** and are never mounted in `backend.py`; broken root-relative imports. Wire or delete.
- **[ORPHANED] intent_signal ("prayer") extraction (ADR-013 Contract C).** Persistence complete + tested (`intent_signal_persistence.py`) but **no detection prompt and zero callers** — the consumption side has no live producer.
- **[ORPHANED] `conversation_pipeline/` orchestrator + 8 stages (ADR-030 §D3).** Fully built + tested, imported only by tests; the 3308-LOC `stt_ws_session.py` + 1523-LOC `import_bulk_pipeline.py` still own the live flow. Finish cutover or delete (tracked in TECH_DEBT).

## Settings status honesty + 3-lane redesign (2026-05-30)

- **[FIXED] Home "ACTIVE" chip could show green for a not-running backend.** Original FluidAudio case (planned, no sidecar) fixed; adversarial review then found it survived for cloud backends (status "configurable", no key, no probe) and for local servers in the pre-probe window. Fixed: green now = probe-verified running only (`lct_app/src/components/settings/backendState.js` shared `runState`/`isServing`, consumed by `BackendCard.jsx` + `CapabilityLane.jsx`). Selected-but-not-running → amber; cloud/unprobed → neutral "SELECTED".
- **[KNOWN] Diarization lane models only the dedicated post-flush diarizer.** Speaker labels can also come from the STT provider (whisper/openai routes with `supports_diarization`); the UI now says "via STT" when the active STT entry has `provides_diarization`, but the two diarization sources are not unified.

## Full-offline local bring-up: bugs + config gaps (2026-05-29)

Found wiring a fully-local (no-cloud) run + E2E on branch `feat/e2e-audio-graph-zoom`.

- **[FIXED] `share_api` wrong-module import (blocking, on `main`).** `lct_python_backend/share_api.py:63` imported `get_async_session` from `lct_python_backend.db` (only exposes `Database`), not `lct_python_backend.db_session` (canonical; ~18 other API modules use it). Backend crashed at import (`ImportError: cannot import name 'get_async_session'`). Any fresh boot of `backend.py` hits this. Fixed.
- **[FIXED] Missing `greenlet` dependency (blocking).** SQLAlchemy async (`db_session.py` `create_async_engine`/`AsyncSession`) requires `greenlet`; pinned `sqlalchemy==2.0.25` markers didn't pull it on this platform → every async-DB request 500'd ("the greenlet library is required... No module named 'greenlet'"). Added `greenlet>=3.0.0` to `lct_python_backend/requirements.txt`.
- **[CONFIG] `STT_HTTP_TIMEOUT_SECONDS` default too low for file STT.** `.env.example` ships `10` (code default 30). Multi-minute audio via remote whisper exceeds it → `WriteTimeout` after retries (~77s) and the upload SSE errors. Worked around with 600 locally. Recommend a larger default for the upload/file path or a dedicated upload-timeout knob separate from the live-STT chunk timeout.
- **[CONFIG] Default local chat model `glm-4.6v-flash` unusable for graph-gen.** It is a vision model; the transcript→graph JSON call takes >120s on the RTX LM Studio → hits `LOCAL_LLM_TIMEOUT_SECONDS=120`, then falls back to Modal Qwen (unreachable) → graph never generates. Switched to `openai/gpt-oss-20b` (~6s warm). Recommend a fast text default.
- **[CONFIG] LM Studio rejects `response_format: json_object`.** Errors `'response_format.type' must be 'json_schema' or 'text'`. With `LOCAL_LLM_JSON_MODE=true` the gateway 400s then retries text-mode. Set `LOCAL_LLM_JSON_MODE=false` to avoid the churn; consider gateway `json_schema` support.
- **[CONFIG] Dead online fallbacks remain in offline mode.** With `DEFAULT_LLM_MODE=local` the provider chain still includes Modal Qwen + OpenRouter; Modal is unreachable (ReadTimeout) and is tried on any local failure, adding latency. True-offline should make the provider list local-only.
- **[LATENT BUG] `ZoomControls.jsx:11` imports `useEffect` from `'prop-types'`** (should be `'react'`). If that component mounts, its keyboard-shortcut `useEffect` throws. The live level-of-detail UI is the `MinimalGraph` tier-tab strip (`moments/ideas/topics/themes/arcs`), not `ZoomControls`, so this is currently latent. Fix the import or remove the unused component.
- **[PERF] IndrasNet whisper (:7777) ~4× realtime.** 20s→86s; full 8-min file ≈ 25–35 min. Not blocking but slow for large imports; worth profiling the orchestrator (model size / diarization cost) from the IndrasNet side.

## Consumption-prayer feature follow-ups (2026-05-18)

The manual-trigger consumption-prayer feature (chip + drawer + selection toolbar in `NewConversation.jsx`, talking to IndrasNet via the proxy in `lct_python_backend/consumption_prayer_api.py`) shipped this session. Backend tested (93 unit tests pass). What's pending:

- **Frontend not browser-verified yet.** Components are syntactically clean and follow existing LCT React conventions (JSX + Tailwind + PropTypes), but the live render in `npm run dev` hasn't been smoke-tested. Risks: selection-rect positioning under specific viewport widths, drawer animation timing with the existing `animate-slideIn`, chip z-index against other floating overlays, contact picker dropdown overflow on narrow screens. Recommended next step: bring up dev server, open `/new`, drag-select a sentence, walk through chip → drawer round-trip.
- **Auto-detect path deferred (task #17).** `agenda_query_detector.py` (51 tests, name-grounded watch list + 56 phrase substrings) is built but NOT wired into `stt_live_runtime`. Today only the manual selection-toolbar trigger fires lookups. Auto path requires: session-registry to push WS events from an HTTP-initiated lookup, OR routing the detector's HTTP call through the same response-return path the manual endpoint uses. Picking the shape is the open question.
- **WS event emission (task #5) + WS handler in NewConversation (task #8) deferred.** Manual MVP uses HTTP response → state update; no WS push needed. These re-open only when auto-detect lands.
- **Session-start contact picker (task #18) deferred.** The selection toolbar has its own per-selection picker with smart defaults (selection-mentioned names bump to top), so a session-level picker is optional UX rather than required wiring.
- **ADR not yet written (task #9).** The consumption-prayer design — production/consumption distinction, prayer-type slot architecture for the toolbar, manual-first MVP rationale, HTTP-vs-WS choice — lives in commit message bodies and session memory entries. Promote to a proper ADR when the design has weathered some real use.
- **`lct_python_backend/services/consumption_trigger.py` + tests stay uncommitted on disk** — the implicit-detection LLM gate (41 tests, all pass) was mothballed when the user picked explicit-verbal-trigger as MVP. Lives alongside committed code so it's available to revive without re-deriving. Should stay uncommitted unless/until the implicit path becomes interesting again.

Operational note: deployed IndrasNet flapped under sustained load this session (the populate-contact-paths script triggered ~150+ rapid `POST /api/contacts/{id}` calls; the server started returning timeouts after ~50). Retry logic in `scripts/populate_contact_note_paths.py` handles it but suggests IndrasNet has a request-handling bottleneck that's worth investigating from their side — not blocking us.

## Deployment Security Follow-ups (2026-05-07)
- Docker build context can include local secrets because the repo currently has no `.dockerignore`, while `Dockerfile` copies `lct_app/` and `lct_python_backend/` into build stages. Impact: local `.env` files or other ignored-but-present credentials can be baked into an image or exposed to the Docker daemon during build; blocker status: deployment-blocking for public/server use. Recommended next step: add a restrictive `.dockerignore` that excludes `.env*`, local caches, virtualenvs, `node_modules`, `.tmp`, test artifacts, logs, and other non-source files before building deploy images.
- Frontend dependency audit was cleaned on 2026-05-07 (`npm audit --package-lock-only --json --prefix lct_app` reports 0 vulnerabilities), but the Docker frontend build stage still uses `npm install` rather than a reproducible lockfile install. Impact: future image builds can drift from the audited lockfile within semver ranges. Recommended next step: switch the Docker frontend build stage to `npm ci` after confirming the lockfile is committed and CI/build cache behavior is acceptable.

## Verification Follow-ups (2026-04-13)
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py::test_graph_timer_forces_update_when_accumulator_keeps_accumulating` currently fails under local verification because `TranscriptProcessor._run_batch_timer()` defers flush when pending text remains below `graph_min_flush_chars` (default 80 chars), so the test's short `"First finalized transcript chunk."` input never forces a graph update after the timer. Impact: unrelated runtime verification noise during graph-work sessions; blocker status: non-blocking for authored-hierarchy rewrite, but it weakens confidence in timer-path coverage. Recommended next step: decide whether the test fixture should lower `graph_min_flush_chars` explicitly or whether the timer behavior has drifted from the intended product rule and should be changed in code.

## Runtime Blockers (2026-02-10)
- Live/import LLM routing mismatch (confirmed 2026-04-03): import graph generation loads `llm_providers` and can honor the saved provider list, but `/ws/transcripts` only loads `llm_config` and constructs `TranscriptProcessor` without `providers`, so live graph generation silently falls back to `get_default_providers()` from `llm_config.py` instead of the saved provider order/credentials. Impact: live and import can use different LLM backends under the same visible settings, and any serious LLM BYOK implementation must fix the live seam first. Recommended next step: thread runtime provider lists into `WsSessionContext` and standardize runtime LLM overlay behavior across live + import.
- Online STT credential blocker (confirmed 2026-03-20): the currently configured OpenAI audio credential returns `401 Unauthorized` against `https://api.openai.com/v1/audio/transcriptions`, so the online diarized fallback route is configured in settings but will not execute successfully until that key is replaced/rotated.
- `live_conversational_threads` STT defaults point all providers to `ws://localhost:43001/stream`, but no local listener is running on port `43001`.
- Active local Parakeet service (`http://localhost:5092`) is HTTP-only (`/v1/audio/transcriptions`) and does not provide the websocket `/stream` endpoint expected by `AudioInput` provider socket flow.
- Live graph updates from `/ws/transcripts` depend on local LLM generation (`lct_python_backend/services/transcript_processing.py`), but configured LLM base URL `http://100.81.65.74:1234` is intermittently unreachable/timing out; result is no `existing_json` updates even when transcript events are persisted.
- During shutdown, long-running local LLM calls can keep backend workers alive long enough for `start.command` to force-kill the backend process after grace timeout; investigate graceful cancellation/timeout handling in transcript processing path.
- E2E input blocker for cloud-backed media: Google Drive file-provider paths can be present in Finder with size metadata but not materialized locally; direct reads/ffmpeg decode can block indefinitely until file is downloaded (`/Users/aditya/Library/CloudStorage/.../ZOOM0123.MP3` repro).
- Under sustained high-throughput websocket streaming (scripted `audio_chunk` bursts), `final_flush` ack can still take ~28s (`flush_ack_ms=27940` observed on 2026-02-14) even with Gemini mode enabled; likely backlog-dependent in STT/flush sequencing and needs follow-up if low-latency stop behavior is required.
- After the latest flush refactor, `flush_ack` is intentionally near-immediate (~1 ms) but graph updates now arrive asynchronously after ack; clients that disconnect immediately after receiving `flush_ack` can miss late `existing_json`/`chunk_dict` updates unless they keep the socket open briefly.
- During `POST /api/import/process-file` retries on 2026-02-25, STT chunk requests to `http://100.81.65.74:8001/v1/audio/transcriptions` still fail repeatedly with transient transport errors (`ReadError`, `RemoteProtocolError`), so retry/backoff improves resilience but does not fully recover while WhisperX connectivity remains unstable.
- Remote IndrasNet `/api/transcribe` defaults missing `diarize` form fields to `"true"` (confirmed via remote code inspection on 2026-03-08). Callers that omit the field can trigger unexpected diarization latency/GPU load even when their local feature flag is off; fix callers to send `diarize=false` explicitly or change the proxy default.
- Remote IndrasNet GPU overflow path is currently unreliable under contention: a live probe on 2026-03-08 fell through to Modal WhisperX and returned `workspace billing cycle spend limit reached`, so queued/live transcription can fail instead of spilling over cleanly when local WhisperX is busy.
- Path-A local diarization prerequisite gap (2026-02-25): `live_conversational_threads/.venv` currently lacks `torch` and `pyannote.audio`, so enabling `STT_PARAKEET_PYANNOTE_ENABLED=true` will fail fast until optional diarization dependencies are installed in the runtime venv.
- Path-A compatibility gap (2026-02-25): `pyannote.audio==3.1.1` is incompatible with `huggingface_hub>=1.0` (runtime error: unexpected `use_auth_token` argument); local setup requires pinning `huggingface_hub<1.0`.
- Path-A media decoding instability (2026-02-25): direct MP3 diarization path intermittently fails in torchaudio/libmpg123 with tensor-size mismatch (`Expected size 160000 but got 159165`) on some files; converting inputs to PCM WAV before diarization avoids this failure in current testing.
- Local Parakeet content variance (2026-02-25): some short mp4/webm uploads return empty transcripts (no text segments) while equivalent speech WAV clips transcribe correctly; likely codec/content sensitivity that needs a deterministic preprocessing fallback in upload flow.
- ~~Obsidian canvas export gap for upload-generated conversations (2026-02-25)~~ **RESOLVED (2026-03-05)**: `persist_import_graph()` added to `import_persistence.py` and called after `processor.flush()` in `import_bulk_pipeline.py`. `Node`/`Relationship` rows are now materialized for import-flow conversations; `POST /export/obsidian-canvas/{conversation_id}` returns 200.
- ~~Live/headless conversation semantic-persistence gap (confirmed 2026-03-20)~~ **RESOLVED (2026-03-20)**: ADR-019 Phase 1 moved canonical live graph persistence to the backend (`live_graph_persistence.py` + `stt_ws_session.py`). Finalized live/headless graph updates now materialize durable `Node`/`Relationship` rows without depending on the browser autosave hook.
- ~~Imported-audio speaker-materialization gap (confirmed 2026-03-20)~~ **RESOLVED (2026-03-20)**: import audio now persists canonical `Utterance` rows and speaker evidence, and the Anand 10-minute validation conversation (`1349fc27-c9dc-4b97-92e0-571df28c9754`) materialized `79` utterances plus `79` speaker-segment assignments. Paired `.canvas` + `.txt` export now reads from that durable transcript/read-model state instead of an utterance-less fallback.
- Import diarization job observability gap (confirmed 2026-03-20): `import_diarization_queue.py` still keeps job state in memory, so background job ids can disappear after process restarts or when debugging later from a fresh client. Impact: non-blocking for the new immediate import speaker-materialization path, but still weak for operator visibility, retry/debug UX, and long-running background refinement. Recommended next step: move import diarization job state into a durable store and expose terminal job outcomes independently of process lifetime.
- ~~Artifact auto-routing confirmation gap (confirmed 2026-03-21)~~ **RESOLVED (2026-03-21)**: artifact exports are now tracked in `PipelineArtifact`, and renaming speakers from the legend triggers a backend reroute/re-export pass via `POST /api/conversations/{conversation_id}/artifacts/reroute`. The first import still lands safely at the root `Conversations/` folder, but once names are confirmed the paired `.canvas` + `.txt` files can be regenerated into the participant folder without rerunning STT or spending additional API credits.
- ~~Import graph densification semantics gap (confirmed 2026-03-21 on Anand rerun `7c5e5141-1441-4120-bd29-3113a29cca0b`)~~ **RESOLVED (2026-03-21)**: `import_graph_refinement.py` now includes first-pass `contextual_relation` / `edge_relations` / `linked_nodes` in the refinement prompt and rejects any refined graph that collapses previously present contextual structure. Follow-up validation on conversation `8aa49f33-2e0e-4444-806c-318a71c58673` preserved and improved relational richness (`edge_count 40 -> 44`, `contextual_node_count 20 -> 20`, `linked_node_count 20 -> 20`, `tangent_count 0 -> 1`, `return_count 0 -> 3`), and the exported canvas shifted from a single-row strip to a multi-band graph (`21` text nodes, `174` edges, `14` x-columns, `13` y-bands).

## Validation & Testability (2026-04-03)
- Optional dependency import-coupling in backend module graph (confirmed 2026-04-03): importing `import_api` or `transcript_processing` in focused tests currently requires `google-genai`, `pydub`, and `pdfplumber` to be installed because optional LLM/media/parser integrations are imported eagerly at module load time. Impact: unit/integration tests on lean dev environments fail during collection before exercising actual behavior, which hides logic regressions behind workstation setup. Recommended next step: lazy-import optional integrations in production modules or centralize shared stubs in `conftest.py` / test helpers instead of duplicating them per test file.

## Sibling Repo UI Validation Debt (2026-04-09)
- `TemporalCoordination/grimoire/IndrasNet/indras-ui` does not currently offer a clean whole-app TypeScript build signal. `npm run build` hits two kinds of preexisting failure:
  - sandbox-unfriendly writes to `node_modules/.tmp/*.tsbuildinfo`
  - broad unrelated TS errors in untouched files under `_drafts`, `database-viewer`, `media-router`, `DesignPlayground`, and other UI modules
- Impact: non-blocking for the new GPU priority policy feature itself, but blocking for high-confidence frontend validation on future IndrasNet UI work until the baseline is cleaned up or a narrower CI target is introduced.
- Recommended next step: add a targeted UI validation command for production surfaces only, or reduce the existing `indras-ui` TS error floor so feature work can use full `npm run build` as a meaningful signal again.

## Frontend Persistence / Autosave (2026-04-03)

### Duplicate server autosave paths in the browser
- The frontend currently uses two separate server persistence paths for live/new sessions:
  - `lct_app/src/hooks/useAutoSave.js`
  - `lct_app/src/components/audio/useAudioInputEffects.js`
- Both can write conversation state back to the backend, which risks redundant writes and makes it
  harder to reason about future auth-gated save behavior.
- Blocker status: non-blocking for the new IndexedDB latest-draft slice; potentially confusing for
  the upcoming account-auth/save-ownership work.
- Recommended next step: consolidate browser-originated server persistence into one explicit path
  before adding auth-gated saved conversations.

## ADR-018 Edit History Contract Mismatch (2026-03-20)
- `EditHistory.jsx:178` expects `edit.user_comment`, `statistics.by_target_type`, and optional `edit.feedback` — these field names must match whatever the backend API returns. ADR-018 proposes collapsing `EditFeedback` into `annotations` and adding `actor_type`, but the frontend has not been updated to match either the current or proposed contract.
- Semantic overcount risk: if `user_comment` continues to mean "initial edit rationale" (set at creation time), then counting non-null `user_comment` as "feedback count" will overcount — every edit with a rationale will appear as having feedback. ADR-018 should clarify whether `user_comment` is rationale (immutable at creation) or annotation (post-hoc), and the frontend counter logic should match.
- `actor_type` is not yet on the `EditsLog` model (`models/interaction.py`), so the export endpoint cannot filter by actor. This is the real gap for training data export — without it, LLM-suggested edits cannot be excluded.
- Migration assumption bug (confirmed 2026-03-20): `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` originally assumed the legacy `edit_feedback` table always existed and called `op.drop_table('edit_feedback')` unconditionally. On local DBs that never had that table, `alembic upgrade head` stopped at `add_intent_signals`, which in turn blocked later schema work such as Phase 2A utterance speaker columns and broke canvas export with `column utterances.speaker_source does not exist`.
- Alembic version-width bug (confirmed 2026-03-20): the original Phase 2A migration revision id `add_speaker_segments_materialization` was longer than the local `alembic_version.version_num` width, so Alembic could run the DDL and still fail when writing the new version marker (`value too long for type character varying(32)`). This blocks `upgrade head` on local PostgreSQL until the revision id is shortened.
- Blocker status: non-blocking for current usage; blocking for training data export feature.
- Recommended next step: implement ADR-018 decisions on the model layer first (`actor_type` column + migration), then update the API response shape, then update `EditHistory.jsx` to match.

## Divergent Shadow Copies in Frontend (2026-03-20)
- Three `(1)` suffixed files in `lct_app/src/components/` are divergent shadow copies (not byte-identical duplicates): `AudioInput (1).jsx`, `ExportCanvas (1).jsx`, `ThematicView (1).jsx`. They are not imported anywhere but risk accidental use. Should be deleted after confirming no unique code worth preserving.

## Tech Debt Scan Findings (2026-03-19)

### Stale TODOs — Deferred Decisions
- **`analysis_events` table** (`intent_signal_persistence.py:12,101,235`): ADR-013 approved intent signals schema but the `analysis_events` table referenced in 3 TODOs was never created. **Decision: defer.** Intent signal persistence works without it. Remove TODOs and add `analysis_events` as a future schema extension when cross-session signal analytics are built (ADR-016 scope).
- **Alert handlers** (`instrumentation/alerts.py:339,349,359`): Email, Slack, and webhook handlers are stubbed with log-only implementations. **Decision: keep stubs, add deprecation note.** Alerting is not on the near-term roadmap. If a monitoring need arises, integrate with an external service (e.g., PagerDuty, Grafana alerting) rather than building custom delivery.
- **Edit `user_id` from auth** (`edit_history_api.py:58`): Resolved by ADR-018 — replace with role-based `actor_type` field.

### Layer 2 API Mounting
- **`claim_api.py` and `argument_api.py` are not mounted** in `backend.py`. The backend services are fully implemented but the HTTP endpoints are unreachable. **Decision: defer mounting until frontend consumers exist.** The services work as internal modules (called by analysis_api). Mounting them without a frontend would create unused attack surface. When argument tree visualization is built, mount them and add integration tests.

### Pre-existing Security/Settings Bugs (found during PR #44 review)
- **STT cloud API keys silently discarded on save** (`useSttSettingsForm.js:38-49`): `normalizeSttSettings(form)` calls `normalizeCloudFallbackProviders()` which forcibly rewrites every cloud provider's `api_key` to `""` before the save request is sent. Freshly entered OpenAI/OpenRouter keys never reach the backend. The UI looks writable but silently drops credentials. **Pre-existing, not introduced by PR #44.**
- **`AUDIO_DOWNLOAD_TOKEN` leaked to browser** (`stt_config.py:205-217`, `SttDiagnosticsPanel.jsx:160`): `sanitize_stt_config_for_client()` masks cloud provider API keys but leaves `download_token` untouched. The diagnostics panel renders it verbatim. **Pre-existing, not introduced by PR #44.**

### Data-Integrity Bug
- **`_iter_contextual_relations` fallthrough bug** (`import_persistence.py:78-88`): When `_add()` rejects a duplicate or empty relation in list-of-objects input, the code falls through to `item.items()` which yields raw dict keys (`related_node_name`, `relation_text`) as graph node names. This corrupts graph data for any LLM output with duplicate node references. Fix: add `continue` after the `_add` call in the list branch. Documented in `test_import_persistence_helpers.py`.

## Deployment Blockers (2026-04-03)

### VPS public ingress blocked outside host
- Backend bootstrap on `15.223.245.244` succeeded locally: Postgres, `lct-backend`, and Caddy all start; `http://127.0.0.1:8000/api/import/health` returns `200`.
- Public access to `http://15-223-245-244.sslip.io` and `https://15-223-245-244.sslip.io` times out from outside the VPS.
- Caddy/ACME logs show Let’s Encrypt `http-01` and `tls-alpn-01` challenge failures caused by connection timeouts to `15.223.245.244` on ports `80/443`, which strongly suggests an external firewall/security-group rule rather than an application failure.
- Blocker status: blocking public backend deployment and therefore blocking Vercel frontend cutover.
- Recommended next step: open inbound `80/tcp` and `443/tcp` (and keep `22/tcp`) in the VPS provider firewall / AWS security group, then re-run the public smoke test and allow Caddy to obtain the certificate.

## STT Orchestrator Findings (2026-04-08)

### Full IndrasNet startup can hang before port bind on Windows after agent autostart
- After surgically syncing the remote `agents/routes/transcription.py` websocket route and the Python-compat fallback fix to `100.81.65.74`, a controlled restart of the Windows `7777` web server no longer produced the old stale-HTML behavior, but the server still failed to accept traffic.
- Evidence from redirected remote startup logs:
  - `python -m grimoire.IndrasNet.agents.web_server.app` on port `7777` logs `Started server process [...]` and `Waiting for application startup.`, then never reaches `Application startup complete.` and never opens a `LISTEN` socket on `7777`.
  - The same app started with `PYTEST_CURRENT_TEST=1` and `PORT=7778` reaches `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`, proving the base FastAPI app and the new websocket route can boot when the test-skipped startup block is disabled.
- The isolating difference is the lifespan block guarded by `if not os.getenv("PYTEST_CURRENT_TEST")` in `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py`, which auto-starts agents/services and schedules background workers.
- Most likely root cause: Windows multiprocessing spawn during agent autostart. `TemporalCoordination/grimoire/IndrasNet/agents/web_server/agents.py` starts `beeper` / `obsidian` / `meet` via `multiprocessing.get_context("spawn")` during web-server startup; on the affected host, that path repeatedly imports `grimoire.IndrasNet.agents.web_server.app` (matching the repeated `runpy` warnings in stderr) and appears to prevent the parent Uvicorn process from completing startup/binding `7777`.
- Secondary observation: the temporary healthy diagnostic listener on `7778` was reachable on `127.0.0.1` from the Windows host, but timed out from the LCT machine over Tailscale. That suggests a separate external-access/firewall policy on nonstandard ports, but it is not the primary blocker for the real `7777` route.
- Impact: even with the websocket route deployed, the production `7777` web server can fail before bind, leaving LCT unable to reach either `/api/transcribe` or `/api/transcribe/stream`.
- Blocker status: blocking remote end-to-end validation of the orchestrated live websocket path.
- Recommended next step: make agent autostart deferrable or disable it during web-server boot on Windows, then confirm `7777` reaches `Application startup complete.` before re-testing `/api/transcribe/stream`. The lowest-risk diagnostic patch is an explicit env flag to skip only agent autostart (not the whole lifespan), which should confirm whether `start_agent_process(...)` is the true blocker.

### WhisperX websocket proxy on Windows must use `127.0.0.1`, not `localhost`
- During live validation on 2026-04-09, the Tailscale path itself was proven healthy: raw TCP, HTTP, and websocket handshakes to `100.81.65.74:7777` all worked while the remote IndrasNet server was alive.
- The remaining realtime-stream failure came from the orchestrator proxy's upstream hop. On the Windows host:
  - `http://127.0.0.1:8001/health` returned healthy status
  - `ws://127.0.0.1:8001/v1/audio/stream` connected successfully
  - `ws://localhost:8001/v1/audio/stream` timed out during opening handshake
- Root cause: the websocket proxy in `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` built its upstream URL from the WhisperX HTTP base URL and preserved `localhost` in the netloc. On this Windows host, the realtime websocket server is reachable via IPv4 loopback but not via `localhost`.
- Impact: clients could connect to `/api/transcribe/stream` over Tailscale, but the proxy immediately failed when it tried to reach WhisperX upstream, so no transcripts were produced.
- Status: fixed in sibling repo commit `3a999b1 fix(transcription): use IPv4 loopback for whisperx stream proxy`.
- Validation: after the fix, end-to-end websocket transcription through `ws://100.81.65.74:7777/api/transcribe/stream` succeeded from the LCT machine, reducing the sample turnaround from about `29.9s` on the old HTTP path to about `7.6s` on the first streamed run.

### Remote IndrasNet `/api/transcribe` route returns 500 after coordinator timeout
- Reproduced against the active Windows/Tailscale orchestrator at `http://100.81.65.74:7777/api/transcribe` with a short local sample posted from the LCT machine.
- Observed behavior: request spends about `10s` in the orchestrator path and returns `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}` instead of falling back cleanly.
- Root cause in remote orchestrator code: `core/gpu_backends.py:818-823` calls `asyncio.current_task().cancelling()` directly inside the `except asyncio.CancelledError` fallback path. That method exists on Python 3.11+, but the active Windows environment appears to be older (`_asyncio.Task` without `cancelling()`), so the fallback path itself crashes.
- Impact: live and upload callers using the `7777` route can hard-fail instead of degrading to Modal WhisperX when the local GPU slot is busy.
- Recommended next step: patch the remote orchestrator to use the same Python-3.9-safe pattern already present in `core/llm.py` (`getattr(task, "cancelling", lambda: False)()`), then re-test the `7777` path under load.

### Coordinator priority does not forcibly interrupt in-flight WhisperX work
- `agents/routes/transcription.py:75-84` already submits LCT requests at `priority=0` (`CRITICAL`), so there is no higher-priority knob available today for live transcription callers.
- The GPU coordinator can signal preemption (`core/gpu_coordinator.py:233-247`), but the active single-file WhisperX route in `core/gpu_backends.py:797-807` awaits one long HTTP call to `localhost:8001` and only inspects `task.preempt_signal.is_set()` after that call returns.
- Result: a CRITICAL live request can jump the queue for the next slot, but it does not forcibly stop an already-running background WhisperX transcription unless that background workflow is chunked/cooperative. Some reprocessing flows are cooperative (`core/reprocessing/audio.py:221-383`), but the direct `/api/transcribe` path is not.
- Impact: priority helps only at chunk boundaries or between jobs; it does not solve long in-flight background transcriptions monopolizing WhisperX.
- Recommended next step: either route live STT directly to the WhisperX server/streaming path, or make background WhisperX consumers chunked/cooperative so they can yield quickly to CRITICAL live requests.

## Developer Warnings (2026-02-14)
- `lct_app/src/components/ContextualGraph.jsx` and `lct_app/src/components/StructuralGraph.jsx` still emit preexisting `react-hooks/exhaustive-deps` warnings in local lint runs. These do not block runtime but create noisy CI/dev output and should be addressed in a dedicated cleanup PR to avoid mixing legacy graph refactors with the minimal-live-ui scope.
- Frontend production build still emits chunk-size warning (`dist/assets/index-*.js` > 500 kB). This is preexisting technical debt and not introduced by the bulk-upload patch; track for a separate code-splitting pass.
- Runtime settings still lack a unified cross-service readiness model. STT cloud fallback providers now support backend-backed `Save & Test`, but Gemini online credentials, embeddings credentials, and broader runtime confidence/benchmark states are still env-driven or probe-limited.
- Repo-wide `npm run lint` is currently red from a large preexisting ESLint backlog across unrelated UI files (`playwright.config.js`, thematic/formalism/export helpers, older graph components, analysis pages, etc.). New runtime-settings work can be linted file-by-file, but full frontend lint is not yet a reliable validation gate until that backlog is cleaned up.
- Remote STT topology documentation remains partially stale: `docs/HANDOVER.md` was corrected on 2026-04-08 after verifying the active `TemporalCoordination/grimoire/IndrasNet` orchestrator on `100.81.65.74`, but backend comments in `lct_python_backend/import_api.py` still describe the WhisperX route as `127.0.0.1:7777` / "local WhisperX". Keep repo docs and comments aligned with the verified Tailscale endpoint `http://100.81.65.74:7777/api/transcribe`.
- Validation on 2026-04-08 after the local Option B implementation found a deployment gap on the remote Windows host: `POST http://100.81.65.74:7777/api/transcribe` now succeeds again, but a 2.75s speech sample still took `29.9s` end-to-end and returned `_backend=local_whisperx`, which is too slow for live use.
- The new websocket route is not live on the remote host yet: `ws://100.81.65.74:7777/api/transcribe/stream` rejects the websocket handshake with plain `HTTP 200` HTML, and a read-only remote file check showed `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` does not yet contain `/api/transcribe/stream`. The listening Python process on port `7777` started at `2026-04-06T15:30:25.753Z`, so the remote service is still serving stale code relative to the local repo changes.
- Read-only SSH investigation on 2026-04-08 showed the remote `7777` listener is launched from the expected `TemporalCoordination\grimoire\IndrasNet` tree (`...\.venv\Scripts\python.exe agents/web_server.py` spawning `C:\Users\adity\anaconda3\python.exe agents/web_server.py`), so this is not a wrong-checkout problem. However, the remote `IndrasNet` repo itself is on branch `main` at commit `92bcbeb` and has many unrelated uncommitted changes. That makes `git pull` / branch switching on the Windows host risky; deploy should be a surgical sync of the touched transcription files plus a controlled restart.
- Recommended next step: sync/deploy the IndrasNet `agents/routes/transcription.py` websocket proxy changes to the remote host and restart the `7777` service before judging the live websocket path. After deployment, re-run the websocket smoke test and measure time-to-ready / time-to-final against the same sample.

## Resolved (2026-02-13)
- Alembic DAG/startup blocker resolved:
  - Fixed broken revision links in `lct_python_backend/alembic/versions/*`.
  - Made transcript settings migration idempotent for pre-existing local tables.
  - Shortened transcript migration revision ID to fit `alembic_version.version_num` width.
  - `alembic upgrade head` now succeeds in local startup flow.

## Recording & Data Retention
- Live capture does not store raw audio; cannot re-run improved ASR/diarization later.
- Browser mic session blocks parallel recorders; no way to capture a backup/high-fidelity stream alongside LCT.
- No per-speaker channel capture; group recordings are single-mix, making diarization/prayer detection harder.
- Request: speaker diarization support (e.g., HF `nvidia/diar_streaming_sortformer_4spk-v2`).
- Request: hardware/software path to record separate channels for each participant; open question on viable multi-channel mic hardware.
- Request: prayer mic drops (Aayush, Kuil) with channel-level handling; defer to integrate with Indra's Net.

## Models & Selection
- ASR quality ceiling; no UI to choose models or switch to local models (e.g., TheWhisper).
- Need model selection UI + backend routing; desire to run locally and choose microphone device in Settings.
- No way to pick a microphone input device today.

## Live vs Import Parity
- Live view lacks edge inspection; cannot click edges to see why nodes connect.
- Live view lacks thematic generation/inspection; only available after import/persisted transcript.
- Live sessions only persist on manual save; tab loss drops data and prevents mid-session analysis.

## Graph & UI Polish
- **Resolved 2026-08-26 — macro tiers discarded usable relationship topology:** Option C now builds a deterministic directed quotient graph for topics/themes/arcs from the canonical v2 edge list and many-to-many hierarchy. Shared-ancestor relations remain internal; disjoint memberships receive conserved fractional weight; visible pairs aggregate relation/evidence counts and drive a left-to-right semantic layout. Moments/ideas retain temporal lanes, hiding lines no longer changes geometry, and the HUD discloses projected versus internal relations. The viewer now rejects v1 rather than retaining the nested-edge ambiguity that caused this class of failure.
- **2026-08-26 — Google OAuth brand says `importTranscripts` (confirmed, shared-project decision needed):** the exact production Web client opens the correct Google authorization request, but Google renders the OAuth consent-screen app name configured for Cloud project `bold-rain-455402-b9`. Incognito reproduces it; it is not an LCT routing failure. Impact: recipients reasonably think the wrong app is requesting access. Recommended next step: either rename the shared project brand to an umbrella name such as `Indra's Net — Live Conversational Threads` (fast, affects all clients in that project) or create a dedicated LCT Cloud project/client (clean isolation, more setup/verification).
- Imported audio/export graphs now preserve richer contextual edges and community-aware layout, but node granularity is still biased toward high-level topic chapters rather than finer tangents/returns. A later pass should either add subthread extraction or a second-pass graph refinement step so visually branchy canvases also surface richer thread structure.
- Layout should aim to minimize edge crossings; start with the simplest viable layout option (e.g., current default before exploring layered/Sugiyama) and iterate.
- Need a user setting to hide arrows/edges entirely (Matt’s preference) and to reduce motion.
- Edge animations/colors are distracting; need toggles to reduce motion/adjust theme.
- Auto-focus/follow request: keep view aligned as the conversation progresses.
- Want a toggle so clicking a node pulls linked nodes into the current view (to avoid offscreen neighbors).
- Need a way to surface all related nodes when edges leave the viewport (e.g., related-node tray or auto-cluster).

## Timeline View Friction
- Too many degrees of freedom; frequent zoom adjustments required—needs fixed/preset zoom levels and constrained zoom.
- Edges/flow should be left-to-right for readability.
- Clicking a node in timeline should sync focus/scope in the top view.
- Horizontal scrolling should be easy/smooth.

## Infrastructure / Runtime Drift
- **2026-08-13 — backend restart diagnosis corrected (resolved for this repair):** the apparent competing Anaconda process was the repo venv's Windows redirector child, as already documented in withdrawn ADR-040. Repeated manual stops consumed the IndrasNet supervisor's retry budget; after the standard hidden launcher started the canonical venv listener, a late supervisor launch lost the port bind and exited while the serving PID remained stable through the successful repair. There is no evidence of two live managers fighting over the listener. Recommended next step: avoid forced reloads during long transactions and expose a deliberate maintenance restart/reset path for a supervisor that has reached its retry limit.
- **2026-08-13 — private audio route lacks a download token (pre-existing, security):** startup reports `AUTH_TOKEN` is enabled while `AUDIO_DOWNLOAD_TOKEN` is unset, leaving `GET /api/conversations/{id}/audio` unauthenticated because browser audio tags cannot send the bearer header. Impact: unrelated to `.threads` (audio is excluded), but private stored audio may be fetchable by anyone who can reach the backend and knows a conversation ID. Blocker status: security-critical for any non-loopback/private-audio deployment. Recommended next step: set `AUDIO_DOWNLOAD_TOKEN` immediately or migrate audio delivery to short-lived signed URLs before exposing the backend.
- IndrasNet Windows Scheduled Task `\IndrasNet-WebServer` was previously bypassed by a manual debug launcher `C:\Users\adity\run_web_server_skip_agents.ps1` that forced `INDRAS_SKIP_AGENT_AUTOSTART=1`; this disabled Beeper/Meet/Obsidian autostarts even though DB autostart settings were enabled. Status: mitigated in ops by repointing the task to the repo-owned `scripts/start_web_server_task.cmd` wrapper, but the historical drift explains earlier missing-ingestion incidents.
- The healthy scheduled-task launch still results in a two-step Python chain (`.venv\Scripts\python.exe` parent spawning `C:\Users\adity\anaconda3\python.exe -m grimoire.IndrasNet.agents.web_server.app`) and repeated `runpy` warnings. Impact: currently non-blocking because `7777` binds and agents autostart, but startup behavior remains harder to reason about. Recommended next step: trace why the app re-enters through `anaconda3\python.exe` and whether a single-interpreter launch path is possible.
- Remote Whisper finalization issue was traced to deployment drift at the real WSL `8001` service. The actual listener is a WSL `uvicorn whisperx_server:app` process importing `/home/adity/whisperx_server.py` from working directory `/mnt/c/Users/adity/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/services/transcription`. Impact: the finalization patch was already on disk but a stale long-running process kept serving pre-fix behavior until the WSL uvicorn process was restarted. Current status: mitigated; raw direct websocket validation now returns an `is_final=true` transcript before `done`. Recommended next step: make the WSL WhisperX service launch/restart path explicit and durable so future code syncs do not leave `8001` serving stale logic.
- The WSL WhisperX launch path had a second durability trap even after ownership was standardized: the remote mounted `run_whisperx_server.sh` could carry CRLF line endings, causing `bash` to fail on `set -euo pipefail` while the local repo copy remained healthy. Current status: mitigated manually on the host and guarded in-repo by `TemporalCoordination/.gitattributes` (`*.sh text eol=lf`). Recommended next step: ensure the remote sync/deploy path uses Git checkout semantics or another LF-preserving mechanism, not ad hoc file writes that can reintroduce CRLF.
- After introducing the two-phase `flush_ack`/`flush_complete` contract for `/ws/transcripts`, a real end-to-end Whisper benchmark on a 60s slice still produced `0` transcript events and only `graph_patch` updates. The new protocol exposed the actual blocker: post-flush processing now fails with `badly formed hexadecimal UUID string` before final transcript events can be sent to the client. Impact: the early-close protocol bug is fixed, but Whisper-backed live sessions still do not deliver transcript events end-to-end because a later persistence/graph path crashes during flush. Recommended next step: investigate the UUID parse failure inside `lct_python_backend/services/stt_ws_session.py` post-flush processing, likely around utterance/speaker reconciliation or graph persistence on benchmark-created conversation/session IDs.
- Real browser-driven Whisper validation on April 9, 2026 showed the UUID-error diagnosis above was too narrow. With valid browser-generated UUIDs, Whisper now delivers live transcript events end-to-end (`11` partials, `1` final), but `/ws/transcripts` still never sends `flush_complete` before the frontend’s `6000ms` stop timeout. Root cause from code inspection: `lct_python_backend/services/stt_ws_session.py` sends `flush_complete` only after `TranscriptProcessor.flush()` and `_ensure_graph_persisted(reason="final_flush")`, while `lct_python_backend/services/transcript_processing.py` can synchronously invoke `generate_lct_json(...)` during that flush. Impact: the client closes even after receiving a valid Whisper final because `flush_complete` is coupled to slow graph/LLM persistence work rather than transcript completion alone. Recommended next step: decouple transcript-complete signaling from graph completion, or substantially relax the frontend stop timeout if preserving the current contract.
- The `flush_complete` coupling issue above is now fixed. `lct_python_backend/services/stt_ws_session.py` emits `flush_complete` after transcript flush + `audio_ready`, before slow graph generation/persistence. Current residual issue after the real browser rerun: Whisper transport shutdown is healthy, but the specific validation run still produced only partial transcript events and no final transcript before `flush_complete`. Impact: users should no longer hit a client-side stop timeout just because graph work is slow, but Whisper finalization quality/availability remains inconsistent. Recommended next step: investigate upstream Whisper end-of-session final behavior and whether LCT should synthesize/promote a final when backend-websocket Whisper ends with only partials.

## Priorities & Scope
- Focus first on core transcript viewing/search/retrieval and navigation; defer pipeline steps (e.g., contextual progress markers/formalism triggers) until basics are solid.

## Test Environment Compatibility (2026-08-17, pre-existing)

- Full backend unit runs fail `test_openai_sdk_blocks_cloud_via_httpx` before
  exercising the egress guard because the installed OpenAI SDK passes the
  removed `httpx.Client(proxies=...)` argument. Impact: one security regression
  test cannot run in this environment. Non-blocking for PR #170; align the
  OpenAI/httpx versions in a dedicated dependency change.
- On Windows, the extreme traversal case `../../../../tmp/evil` can make
  `Path.resolve()` raise `PermissionError` before `AudioStorageManager` converts
  traversal into the public `ValueError`. The path is still not accepted, but
  the error contract differs. Non-blocking for PR #170; reject lexical parent
  traversal before filesystem resolution in a focused security repair.

## Independent-review artifact hygiene (2026-08-20)

- `scripts/review_pr_with_claude.ps1` says `.agent-reviews/` is ignored and
  writes raw cloud-review packets there, but the root `.gitignore` does not
  contain that directory. Impact: a future broad `git add` could stage source
  context or private review material. This did not occur during the Option C
  review; its raw packet was not written in the repository. Recommended next
  step: add `/.agent-reviews/` to `.gitignore` in a dedicated tooling-safety
  change and add a script assertion that refuses to run unless the output path
  is ignored.

## User Stories (When/Why)
- Primary: After a live or imported meeting, I need to quickly surface decisions, action items, and supporting quotes, then export/share them for slides, docs, or follow-up messages with minimal navigation overhead.
- Creative: During a brainstorming session, I want the graph to auto-cluster related ideas and let me hide edges so I can drag a “storyline” into a deck outline without visual clutter.
- Creative: While reviewing a contentious discussion, I want to click a node and have all related nodes pulled into view, then generate a concise narrative I can fact-check before sharing with stakeholders.
- Creative: In a workshop, I want a smooth left-to-right timeline with fixed zoom presets so I can jump between moments, bookmark highlights, and later re-run higher-quality ASR/diarization on the stored audio for a polished recap.

## 2026-08-25 — Viewer audit follow-ups

- **Participant schema pollution remains at the producer boundary.** Real server
  history returned participant-like values such as `chunk_index`, `doc_id`,
  `title`, `SPEAKER_00`, and markdown fragments. The Library now filters these
  defensively, so this is non-blocking for readers. Recommended next step:
  validate/normalize participant rows during ingestion or API serialization and
  migrate existing polluted rows.
- **Automated accessibility scan is not installed.** The responsive repair has
  semantic and behavioral coverage but no axe-core run. Add axe to the E2E
  harness in a dedicated dependency/testing change.
- **Repository-wide ESLint baseline is red.** `npm run lint` currently reports
  109 errors and 20 warnings across unrelated legacy/API/test files. Scoped
  ESLint for the 2026-08-25 viewer repair is clean. Establish a lint baseline
  or pay down the listed files separately so new changes can use global lint as
  a meaningful gate.
- **Center zoom percentage can lag the ReactFlow viewport in the responsive
  browser suite.** The older macro-overview test observed the canvas at 98%
  while the HUD had not yet rendered `98%` within five seconds. The same test
  passes alone and the focused-node flow is unaffected, so this is non-blocking.
  Recommended next step: make the HUD subscribe to the committed viewport or
  expose one shared camera-state update after `setViewport` completes instead
  of testing two asynchronously updated representations.
- **Resolved — `MeetingView` pre-push timing flake.** Both public-behavior tests
  passed in isolation (~2.2s total) but the first test twice exceeded Vitest's
  default 5s timeout under the full Git Bash pre-push suite; its timed-out React
  work then contaminated the second test with overlapping `act()`/root state.
  The bounded repair gives only these two integration tests 15s while retaining
  every WebSocket, speaker-label, transcript, and replacement assertion.

## 2026-08-17 — Dependency audit and bundle-size warnings (pre-existing, non-blocking)

- `npm ci` reports 10 dependency vulnerabilities (1 low, 8 high, 1 critical).
  This work did not run an unreviewed `npm audit fix`; triage direct versus
  transitive exposure and upgrade through a separate dependency PR.
- The production build reports a ~1.15 MB JavaScript chunk (>500 KB warning).
  No regression was introduced by the small label-only viewer change, but route
  or feature-level dynamic imports should be evaluated separately.
- Impact: security-maintenance and startup-performance risk; not a blocker for
  the argument-topology correctness repair.

## 2026-08-28 — Viewer provenance/navigation repair

- **Resolved — unlocked semantic-tier feedback loop.** Programmatic `fitView`
  motion no longer selects another semantic tier. Unlock seeds a discrete tier;
  only a settled real user zoom gesture can change it.
- **Resolved — aggregate summaries hid their evidence size.** The artifact read
  model now rolls up de-duplicated descendant utterances across many-to-many
  memberships, cards disclose words / elapsed span / turns, and Source opens
  the exact speaker utterances.
- **Resolved — graph arrows had no reader navigation contract.** Up/Down now
  follows authored abstraction membership and Left/Right follows chronology at
  the visible tier, without wrapping or stealing keys from controls/editors.
- **Non-blocking tooling issue — Codex browser helper path overflow.** The
  installed interactive browser controller fails to launch on this Windows host
  with OS error 206. Repo-owned Playwright remains healthy; repair the Codex
  helper/install path separately rather than weakening product validation.
- **Non-blocking detector overclaim — bookmark corner.** Impeccable's side-tab
  heuristic flags the pre-existing transparent CSS triangle in
  `BookmarkCorner`; it is a 12px corner marker, not a thick card-side accent.
- **Non-blocking navigation hardening follow-ups.** A null previous zoom is
  currently coerced to zero inside the pure tier helper, boundary arrows can
  fall through to browser/ReactFlow defaults, Shift+Arrow is not excluded, and
  pending cross-tier focus infers the rendered tier from the first visible node.
  None is reachable as a failure in the validated authored-tier flow; add
  explicit contracts before supporting mixed-level or alternate key maps.
- **Non-blocking chronology fallback.** A tier mixing timestamped and
  untimestamped nodes compares seconds with source-order indices. Normalize
  missing chronology into a separate sort bucket before accepting hand-edited
  or partially timed artifacts.
- **Non-blocking provenance hardening follow-ups.** Cyclic hierarchy input can
  memoize an under-counted descendant union, and a span-only/unlinked metric
  strip uses an overconfident tooltip. Validate hierarchy acyclicity and soften
  the tooltip in a separate evidence-UX repair.

## 2026-08-28 — Real-artifact integrity acceptance repair

- **Resolved — Center then pan could change semantic tiers.** Several camera
  paths used independent booleans/timeouts, so a late ReactFlow completion made
  the requested zoom—not the real final zoom—the next gesture's baseline. One
  generation-ordered viewport tracker now owns every programmatic motion.
- **Resolved — a graph batch was copied onto every leaf's provenance.** Leaf
  source excerpts are now deterministically localized to matching transcript
  fragments. Shared unmatched chunks fail closed instead of claiming the full
  batch.
- **Resolved — live edge enrichment reversed its compatibility direction.**
  Import and live STT now share the same canonical adapter, which attaches the
  source statement as an incoming relation on the target.
- **Resolved — edge aliases and duplicate triples polluted topology.** Relation
  spellings canonicalize before persistence/export, duplicate directed triples
  merge at export, and exact supporting turns survive the full path.
- **Open, non-blocking — old artifacts need re-extraction for precise evidence.**
  Serialization can deduplicate/canonicalize stored edges, but it cannot infer
  which subset of an old batch supported each old leaf. Re-run extraction from
  retained utterances to replace broad historical links; do not mutate them
  heuristically.
  On the acceptance conversation, exact matching could safely rehabilitate
  only 31/135 old leaf excerpts; the other 104 were paraphrased rather than
  verbatim. Their old median provenance set was 35 turns. The generator now
  requires exact contiguous leaf excerpts, but this historical conversation
  still needs a deliberate re-extraction before its leaf evidence is precise.
