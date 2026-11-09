# Map-generation admission: a rolling window and self-releasing slots

- **Date:** 2026-11-05
- **Status:** Proposed
- **Amends:** `2026-10-03-openrouter-worker.md` ("Lifetime counts never reset or refund"; "uncertain failures/cancellation/timeout retain the slot conservatively"). That ADR is unchanged; this records what supersedes those two sentences once deployed.

## Issue

On 2026-11-05 the live Site (`threads.adityaarpitha.com`) stopped generating maps. One test import
transcribed correctly, then OpenRouter returned a refusal (`provider_refused`, HTTP 502 from the
Worker; the upstream status was not recorded). After it, `/api/cloud/health/openrouter` reported
`capacity: "exhausted"`: the attempt count had reached `LCT_OPENROUTER_MAX_REQUESTS`, a lifetime cap.

This is the same jam the branch has cleared by hand seven times: migrations 0008, 0010, 0011, 0012,
0014, 0015 and 0016 each release held attempts by direct SQL. The design guarantees it recurs:
- the cap counts every attempt ever made, so the Site stops generating after N attempts forever;
- a failed, timed-out or cancelled attempt holds one of the two concurrent slots forever, so two
  failures block everyone until a recovery migration is written, reviewed and deployed;
- the public error hides the provider's status, so nobody can tell credits from a bad key.

## Decision

1. **Optional rolling window.** New setting `LCT_OPENROUTER_WINDOW_HOURS` (1–720). When set, the cap
   counts only attempts created in that window. When absent the cap stays lifetime, so behaviour does
   not change until the owner sets it. Any other value leaves generation unconfigured; it never falls
   back to lifetime silently.
2. **Slots free themselves once no Worker can still be running them.** An unfinished attempt holds a
   concurrent slot only while it is younger than `STALE_ATTEMPT_MS` = input window (30 s) + provider
   window (90 s) + 180 s margin = 5 minutes. The Worker aborts its own provider call at those
   deadlines whether or not Cloudflare delivers a client disconnect (the concern in the original ADR),
   so an older unfinished attempt is no longer in flight. It still counts toward the cap; nothing is
   refunded. The replay trial's admission uses the same rule.
3. **Refusals carry the provider's HTTP status** as `upstream_status`, with a fixed reason per status
   (402 credits, 401/403 key, 429 rate limit, 5xx provider error). Provider bodies still never reach
   the browser; the browser picks its own fixed sentence from the status code.

## Why this keeps the original safety

The original ADR already states that request and token caps "are usage bounds, not a guaranteed
dollar ceiling", and that activation requires a "dedicated non-resetting OpenRouter key allowance".
The dollar ceiling is therefore the OpenRouter key's own credit limit. The concurrency slots exist to
bound in-flight work, which this change still does while work can be in flight. The attempt count is
still never refunded.

## Considered positions

- **Keep writing recovery migrations.** Seven so far; each needs review and a deploy, and generation is
  down in between.
- **Release slots on known failures only** (refusal, invalid map). Leaves timeouts and lost Workers
  holding slots, which is the uncertain case the original ADR worried about; the time rule covers all.
- **Drop the attempt cap and rely only on the key's credit limit.** Simpler, but loses the abuse bound
  for a public, sign-in-free Site.

## Consequences

- After deployment, existing unfinished attempts older than 5 minutes stop blocking at once.
- With `LCT_OPENROUTER_WINDOW_HOURS` unset, a Site at its lifetime cap stays blocked. Unblocking it
  needs the owner to set the window (or raise the cap). Suggested start: window 24 h, cap 50, plus an
  OpenRouter key credit limit as the money ceiling.
- The status endpoint reports `attempt_window_hours`.

## Validation

`src/services/serverless/sitesOpenRouterAdmissionWindow.test.js` (new) and the updated
`sitesOpenRouter.test.js`, `sitesOpenRouterRecoveryOct14.test.js` and `openRouterClient.test.js`,
against real migrations on in-memory SQLite. Each new guard was proven by breaking it and seeing its
test fail (slots never freed, slot window shorter than the Worker deadlines, window ignored, bad window
falling back to lifetime, status dropped from the response, client ignoring the status).
