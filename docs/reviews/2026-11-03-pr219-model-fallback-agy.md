# PR #219 model-fallback review — Gemini via Antigravity (2026-11-03)

- Route: Antigravity CLI 1.4.12, `--model gemini-4-argon-high` (self-reported "Gemini 4 Argon (High)"), `--sandbox --dangerously-skip-permissions --disable-slash-commands --print-timeout 25m`, headless from a clean packet directory (no `--mode plan`: it is a no-op with slash commands disabled).
- Packet: `git diff 3ae612b..d217cf1 -- lct_app tests/intent` plus 6 final files (`openRouter.js`, `openRouterPolicy.js`, `serviceHealth.js`, `replayProvider.js`, `openRouterClient.js`, `RecordingConversationMap.jsx`). Code and technical docs only; scanned. Reviewed PR head `d217cf1`. Packet byte-identical after the run (manifest check).
- Duration: 5 min (17:31:48Z–17:36:58Z). Verdict: **GO WITH FIXES**, 3 should-fix, 2 nits, 0 blockers.
- Confirmed by the reviewer: every attempt carries the same `provider.only` and `data_collection`; Gemini never falls back; 404/503 is the only retry set; 502, 408 and every 200 (valid or not) end the loop; one ledger row per admitted generation; a malformed list fails closed before any network call or insert.

## Adjudication (author, verified against the code)

| # | Finding | Holds? | Fix |
|---|---|---|---|
| 1 | Worker accepted fallback ids longer than the 160 characters the client allows, locking the recording UI while health said "enabled" | yes | per-entry `MAX_MODEL_ID = 160` in `fallbackModels()`; total cap sized for 3 entries |
| 2 | Client mapped `no_model_route` (502) to the generic "check setup" message | yes | specific message in `generationFailures` |
| 3 | A space after a comma disabled generation entirely | yes | entries are trimmed; a blank entry still fails closed |
| 4 | `sitesServiceHealth` tests reached `reachable: true` through the `unknown` path | yes | default mock now serves a routed `google-vertex/global` endpoint and asserts `available: 1` |
| 5 | Health cache key omitted the provider | yes | key is `provider|models` |

New tests: an over-long id and a blank-between-spaces entry fail closed; spaces around commas are tolerated; Gemini stays single-model with an OpenRouter list set; the health cache re-checks on a provider or list change; the client explains `no_model_route`. The 4 behaviour tests failed before the fix. Full vitest 138 files / 1298 tests, `build` and `build:sites` pass, eslint clean on touched files.

Noted, not fixed here: `replayBudget()` matches only `provider/…` tags, not a bare `provider` slug. `replayProvider.js` is being changed by stacked PR #220, so this is left for a separate small fix.

## Full review text

VERDICT: GO WITH FIXES

### Findings

1. **[should-fix] Per-model 160-character limit is enforced on the client but not in server policy validation**
   - **File & line:** [openRouterPolicy.js](final/openRouterPolicy.js#L25-L31), [openRouterClient.js](final/openRouterClient.js#L74-L75)
   - **Concrete failure scenario:** Configure `LCT_OPENROUTER_FALLBACK_MODELS` with 1–3 comma-separated model IDs where any single ID is 161–643 characters long (e.g. `vendor/${'a'.repeat(160)}`, 167 chars). [`fallbackModels()`](final/openRouterPolicy.js#L25-L31) checks `text(value, 4 * 160 + 3)` on the whole string and tests each entry against `MODEL_ID` (which has unbounded `*` quantifiers), so [`openRouterPolicy()`](final/openRouterPolicy.js#L33-L50) reports `configured: true, enabled: true` and `/api/cloud/openrouter/status` serves the 167-character entry in `fallback_models`. On the browser, [`getRecordingMapStatus()`](final/openRouterClient.js#L67-L77) rejects any entry with `model.length > 160` via [`unreadable()`](final/openRouterClient.js#L17), locking out the recording map UI with *"Generation setup is unavailable"* while the Worker reports itself healthy and enabled. (Additionally, `4 * 160 + 3` = 643 is sized for 4 models rather than `MAX_FALLBACK_MODELS = 3`, which is `3 * 160 + 2` = 482.)
   - **Confidence:** 1.0

2. **[should-fix] Client drops `no_model_route` on HTTP 502 and falls back to generic `uncertain` message**
   - **File & line:** [openRouter.js](final/openRouter.js#L105-L107), [openRouterClient.js](final/openRouterClient.js#L7-L10) and [lines 57–63](final/openRouterClient.js#L57-L63)
   - **Concrete failure scenario:** Configure at least one fallback model (`wires.length > 1`) when all approved models return HTTP 404 or 503. [`generate()`](final/openRouter.js#L105-L107) throws `OpenRouterError(502, 'no_model_route', ...)`. In [`request()`](final/openRouterClient.js#L57-L63), `generationFailures` only contains `provider_refused` and `invalid_completion`, and `messages` has no `502` entry. As a result, `error.code` is `undefined` instead of `'no_model_route'`, and the user sees the generic `uncertain` string (*"No new map is available. The attempt may remain counted; check setup and allowance before retrying."*) instead of a specific failure message confirming that audio and transcript are preserved and that no approved model had a route.
   - **Confidence:** 1.0

3. **[should-fix] Whitespace around commas in `LCT_OPENROUTER_FALLBACK_MODELS` disables OpenRouter generation**
   - **File & line:** [openRouterPolicy.js](final/openRouterPolicy.js#L27-L29)
   - **Concrete failure scenario:** An operator configures `LCT_OPENROUTER_FALLBACK_MODELS="vendor/model-a, vendor/model-b"` with a space after the comma. [`text()`](final/openRouterPolicy.js#L15-L18) accepts interior spaces (ASCII 32), `.split(',')` produces `["vendor/model-a", " vendor/model-b"]`, and `MODEL_ID.test(" vendor/model-b")` returns `false`. [`fallbackModels()`](final/openRouterPolicy.js#L25-L31) returns `null`, making `configured: false` and taking down OpenRouter generation completely. Either trim entries consistently or document explicitly that no spaces are permitted around commas.
   - **Confidence:** 0.9

4. **[nit] Existing health tests in `sitesServiceHealth.test.js` pass `reachable: true` via `unknown: 1` rather than a routed endpoint**
   - **File & line:** [pr219.diff](pr219.diff#L513-L547), [serviceHealth.js](final/serviceHealth.js#L68-L70)
   - **Concrete failure scenario:** In `sitesServiceHealth.test.js`, the mocked `fetch` returns `{ data: { limit_remaining: 4 } }` for `https://openrouter.ai/api/v1/models/google/fixture/endpoints`. Because `data.endpoints` is not an array, [`modelRoutes()`](final/serviceHealth.js#L57-L76) returns `{ approved: 1, available: 0, unknown: 1 }`, which keeps `reachable: true` only because `unknown > 0`. Also, no test exercises Gemini or `replayProvider` with `LCT_OPENROUTER_FALLBACK_MODELS` set, or verifies health-cache invalidation when `policy.models` changes for the same API key.
   - **Confidence:** 0.95

5. **[nit] Health check cache key omits `policy.provider`**
   - **File & line:** [serviceHealth.js](final/serviceHealth.js#L88-L91)
   - **Concrete failure scenario:** [`providerCheck()`](final/serviceHealth.js#L86-L136) keys its 60-second `checks` map entry on `{ key, models }` (`policy.models?.join(',') ?? policy.model`), but [`modelRoutes()`](final/serviceHealth.js#L57-L76) and [`routeDetail()`](final/serviceHealth.js#L78-L84) depend on `policy.provider`. If `LCT_OPENROUTER_PROVIDER` changes within a warm isolate's 60 s TTL while `key` and `models` remain unchanged, `/api/cloud/health/openrouter` returns the stale provider's route counts and detail string.
   - **Confidence:** 0.9

---

### Explicit Review of Numbered Failure Modes

1. **Privacy pin:**
   - **OpenRouter attempts & retries:** In [`generate()`](final/openRouter.js#L75-L78), `wire.provider = { ...wire.provider, only: [policy.provider], data_collection: policy.dataCollection }` is constructed before building `wires = policy.models.map(model => ({ ...wire, model }))`. Every request in the fallback loop sends a standalone body with the identical `provider.only` and `provider.data_collection` and never uses OpenRouter's `models` array. Both `provider` and `dataCollection` must be valid (`['allow', 'deny']`) for `policy.configured` and `policy.enabled` to be `true`.
   - **Gemini backend:** [`geminiPolicy()`](final/openRouterPolicy.js#L65-L76) overrides `fallbackModels: []`, `models: model ? [model] : []`, and `configured` independently of `LCT_OPENROUTER_FALLBACK_MODELS`. [`generate()`](final/openRouter.js#L70-L78) sets `wires = [wire]` for `policy.backend === 'gemini'`, so Gemini never falls back or leaks OpenRouter fields.
   - **Malformed lists:** When `fallbackModels()` returns `null`, `policy.configured` and `policy.enabled` are `false` (`models: []`), and [`generate()`](final/openRouter.js#L58) rejects with `503 generation_inactive` before any network call or DB insert.

2. **Spend and duplicate work:**
   - [`ROUTE_UNAVAILABLE`](final/openRouter.js#L19) is `new Set([404, 503])`. Under OpenRouter's semantics, `404` means the model/route does not exist and `503` means no provider met the routing constraints (`provider.only` / `data_collection`) prior to dispatch.
   - Statuses where a provider may have accepted or processed the request (`502` upstream failure/bad response, `408` timeout, `200` with an in-body error or invalid map) as well as request-wide refusals (`400`, `401`, `402`, `403`, `429`) are excluded from `ROUTE_UNAVAILABLE` and immediately throw out of the loop without trying another model.
   - Any `200` response proceeds to [`readOpenRouterJSON()`](final/openRouter.js#L110) and [`recordingThreadsFromOpenRouterResponse()`](final/openRouter.js#L111); if the 200 payload contains an in-body error or fails validation, it throws `502 invalid_completion` and never falls back.

3. **Admission ledger:**
   - A single row is inserted into `lct_openrouter_attempts` ([openRouter.js:85-90](final/openRouter.js#L85-L90)) before entering [`openRouterWait()`](final/openRouter.js#L93), and `completed_at` is updated only once ([openRouter.js:119](final/openRouter.js#L119)) after a model returns a valid artifact.
   - All attempts execute inside the single `openRouterWait(request.signal, 60_000, ...)` call, sharing the 60-second deadline and `request.signal` cancellation. Aborts before admission throw `408` without inserting a row; aborts during or after the loop leave `completed_at IS NULL` so the attempt remains counted.
   - Size validation (`> 512 * 1024` bytes) checks all `wires` before admission ([openRouter.js:79](final/openRouter.js#L79)).

4. **Configuration validation:**
   - [`fallbackModels()`](final/openRouterPolicy.js#L25-L31) returns `[]` only for `undefined` or `''`, and returns `null` (which makes `configured` `false` because `Boolean(null)` is `false`, whereas `Boolean([])` is `true`) for `> 3` items, empty entries (`a/b,,c/d` or trailing commas), duplicates (`new Set(list).size === list.length`), repetition of `primary`, non-strings, control characters, or IDs not matching `MODEL_ID`.
   - **Issues found:** See **Finding 1** (`fallbackModels()` does not enforce `model.length <= 160` per entry, allowing 161–643 char IDs that [`getRecordingMapStatus()`](final/openRouterClient.js#L75) rejects) and **Finding 3** (spaces after commas cause valid model IDs to fail `MODEL_ID`).

5. **Health route check:**
   - **Tag matching:** [`modelRoutes()`](final/serviceHealth.js#L58) checks `tag === policy.provider || tag.startsWith(policy.provider + '/')`, matching bare slugs and regional tags while preventing prefix collisions like `google-vertex-x`. (Note: [`replayBudget()`](final/replayProvider.js#L26) still checks only `e.tag.startsWith(policy.provider + '/')` without exact `e.tag === policy.provider`.)
   - **404 vs other:** HTTP 404 or a 200 with no matching endpoint tag counts as `'missing'`; non-200/non-404 statuses, timeouts, invalid JSON, or missing `data.endpoints` arrays count as `'unknown'`. `reachable` is `false` only when `routes.available === 0 && routes.unknown === 0`.
   - **Cache key:** Includes `models = policy.models?.join(',') ?? policy.model` alongside `key` ([serviceHealth.js:88-91](final/serviceHealth.js#L88-L91)); see **Finding 5** regarding `policy.provider`.
   - **Key check failure before routes are read:** `modelRoutes(policy, signal)` wraps every inner promise in `try / catch`, so when `/api/v1/key` fails early ([serviceHealth.js:103-109](final/serviceHealth.js#L103-L109)) or throws ([line 113](final/serviceHealth.js#L113)), `routing` never causes an unhandled rejection, `signal` aborts the remaining sub-requests when `openRouterWait` exits, and `reachable: false` is returned without `model_routes`.

6. **Client and consent:**
   - [`describeModelRoute()`](final/openRouterClient.js#L80-L85) renders `Model: <primary>, or <second>, then <third> if it is unavailable · Provider: <provider>` in [`RecordingConversationMap.jsx`](final/RecordingConversationMap.jsx#L106) whenever `status?.model` is present, naming every model that may receive the transcript above the consent checkbox.
   - [`getRecordingMapStatus()`](final/openRouterClient.js#L73-L76) defaults `status.fallback_models ?? []` so older Site deployments omitting `fallback_models` continue to work, while rejecting non-arrays, `> 3` items, empty strings, non-strings, or strings `> 160` chars.
   - **Issue found:** See **Finding 2** (`no_model_route` error code is not handled in [`openRouterClient.js`](final/openRouterClient.js#L7-L10)).

7. **Tests:**
   - [`sitesOpenRouterModelFallback.test.js`](pr219.diff#L333-L508) exercises the real Worker and SQLite ledger across configuration failure cases, 404/503 fallback with provider pin preservation, non-fallback statuses (`400, 401, 402, 403, 429, 502`, invalid 200 completion), exhausted routes (`no_model_route`), and health endpoint tag matching.
   - **Gaps:** See **Finding 2** (no client test for `502 no_model_route`) and **Finding 4** (`sitesServiceHealth.test.js` hits the `unknown` path on `/endpoints`, and there are no tests for Gemini/replay single-model isolation when `LCT_OPENROUTER_FALLBACK_MODELS` is set or for health cache invalidation on model-list change).

8. **Anything else that should block this:**
   - No blockers found; **Findings 1–3** should be fixed before merge.

---

### Not established

- **Helper implementation details outside this directory:** `openRouterIO.js` (`openRouterWait`, `readOpenRouterJSON`), `openRouterGeneration.js` (`buildOpenRouterGenerationRequest`, `recordingThreadsFromOpenRouterResponse`), `worker.js`, `auth.js`, and Drizzle migration SQL files are imported by the reviewed files but are not included in this directory.
- **Live OpenRouter upstream behavior:** These files cannot establish that OpenRouter never returns HTTP 503 after partial upstream provider execution, nor that every approved fallback model produces valid schema-compliant conversation maps within the shared 60-second wall-clock window in production.

Model: Gemini 4 Argon (High)
