# ADR-061: STT fallback as an ordered engine list (unify primary + fallback)

**Date:** 2026-07-01
**Status:** Proposed
**Group:** interaction + integration
**Supersedes (in part):** ADR-014 (the `live_fallback_priority` route-category vocabulary)
**Related:** ADR-017 (capability-oriented pipeline), ADR-023, ADR-056

## Context

The Runtime settings redesign (left-rail, one capability per section, a single ranked
engine list per capability) surfaced a modelling mismatch that confuses the operator:

- The **primary** live-STT choice is an **engine** (`provider`: `parakeet` / `whisper` /
  `senko` / `openai_audio` …), chosen from the backend catalog.
- The **fallback** is `live_fallback_priority`, an ordered list of **route categories**
  (`remote_whisper`, `external_http`, `openai_audio`, `openrouter_audio`), a *different
  vocabulary* introduced deliberately by ADR-014.

To the operator these read as two unrelated controls ("why do the engines I pick not have a
fallback?"). The redesign wants **one ranked list per capability**: the top row is the
primary (runs first), the rows below are the fallback order. That already fits **diarization**
(`primary` + `fallback_priority` are both engine keys) and the **LLM provider chain**. STT is
the exception, and this ADR decides how to close it.

ADR-014 chose routes for real reasons that we must not lose: routes carry **transport type**
(backend HTTP vs OpenAI realtime vs OpenRouter), **diarization capability** (Whisper/OpenAI
diarize; OpenRouter is text-only), a **degraded** flag, and several **implicit guards** now
living in `stt_live_provider_selection.resolve_live_stt_candidates`:

1. `local_only=True` default short-circuits all fallback.
2. `live_require_diarization=True` default blocks text-only routes (OpenRouter) unless opted in.
3. **OpenAI is tried before remote Whisper** in online-style setups (avoid slow Whisper timeouts).
4. Empty transcript (HTTP 200, no text) counts as failure → next candidate.
5. Candidate dedup by `(provider, transport, endpoint)`.
6. A separate **background diarization** candidate for the live route.

## Decision

Change `live_fallback_priority` from route-category ids to an **ordered list of engine ids**
drawn from the same STT catalog as the primary. The unified ranked list writes the whole order;
row 0 becomes `provider` (primary), rows 1..n become the fallback order.

`resolve_live_stt_candidates` is rewritten to build a candidate **per engine in the ordered
list**, deriving each engine's transport/endpoint/keys from existing config:

| Engine id | Candidate source |
|---|---|
| `whisper` | `provider_http_urls.whisper` (backend HTTP; ws if remote) — replaces `remote_whisper` |
| `parakeet` / `senko` / other local | `provider_http_urls[<id>]` (backend HTTP) |
| `openai_audio` | `cloud_fallback_providers.openai_audio` (OpenAI realtime transport) |
| `openrouter_audio` | `cloud_fallback_providers.openrouter_audio` (text-only, degraded) |
| `external` | `external_fallback_http_url` — the one route with no engine identity (see Open questions) |

The ADR-014 guards are **preserved, not dropped**:
- `local_only` still short-circuits to primary-only.
- `live_require_diarization` still filters out engines that can't diarize (via each engine's
  `supports_diarization`), unless text-only fallback is allowed.
- Empty-as-failure, dedup, and the background-diarization candidate are unchanged.
- **The implicit "OpenAI before remote Whisper" preference (ADR-014 amendment #3) becomes
  explicit user order.** Once the operator controls the ranked list directly, an implicit
  reorder is surprising; we drop the hidden preference and let the user's order stand. This is
  a behavior change and is called out for review.

## Migration (staged, additive; gated on a testable backend)

1. **Backend, additive read:** teach `normalize_live_fallback_priority` to accept both the old
   route ids and the new engine ids. Map legacy routes on read: `remote_whisper→whisper`,
   `openai_audio→openai_audio`, `openrouter_audio→openrouter_audio`, `external_http→external`.
   No stored-data migration required on day one (read-time mapping).
2. **Backend, orchestration:** rewrite `resolve_live_stt_candidates` per the table above behind
   the read-time mapping, with the guards preserved. Full unit coverage first
   (`test_stt_live_provider_selection`), including a test that reproduces each ADR-014 guard.
3. **Catalog:** ensure `backend_catalog` marks each STT engine with `supports_diarization` and a
   fallback-eligibility flag so the UI can grey ineligible engines with a reason.
4. **Frontend:** `live_fallback_priority` becomes engine ids; wire the existing `RankedEngineList`
   into the Speech-to-text section (like `DiarizationSection`), writing `provider = order[0]` and
   `live_fallback_priority = order.slice(1)`.
5. **Persisted write migration:** only after the above prove out, normalize stored settings to
   engine ids on next save.

## Consequences

- One consistent mental model across STT / diarization / LLM: a ranked list where the top runs
  first and the rest are the fallback order. Closes the operator confusion this ADR opens with.
- STT routing stays inspectable and user-controlled (keeps ADR-014's core win) while dropping the
  primary-vs-fallback vocabulary split.
- We lose the implicit OpenAI-before-Whisper reorder; the user's explicit order wins. Operators
  who relied on that must reorder once.
- Higher blast radius: this rewrites the live real-time transcription candidate path. It must not
  ship without unit coverage of every ADR-014 guard AND a live smoke test on a reachable backend.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Hybrid: keep routes, present primary engine pinned atop the route list in one UI list | No backend change; honest to current model | The list is heterogeneous (engine + routes); reorder only applies to routes; the mental-model mismatch persists under the hood |
| B | **True engine-list fallback (chosen)** | One vocabulary end to end; matches diarization/LLM; closes the confusion | Rewrites live orchestration; migration; drops one implicit preference; must preserve ADR-014 guards |
| C | Keep the split, only relabel so "primary = engine, fallback = routes" is explicit | Lowest effort/risk | Does not deliver the unified list the redesign is built around |

## Open questions

1. **`external_http`** has no engine identity (it's a generic URL). Keep it as a synthetic
   `external` pseudo-engine in the list, or move it to an "advanced route" outside the ranked
   list? Leaning: synthetic pseudo-engine, greyed unless a URL is set.
2. **Dropping OpenAI-before-Whisper** (ADR-014 #3): confirm the behavior change is acceptable, or
   keep it as a one-time default ordering that the user can then override.
3. **Diarization eligibility in the list:** grey a text-only engine (OpenRouter) when
   `live_require_diarization` is on, or allow it with a "degraded" tag? Leaning: grey with reason,
   matching the current guard.

## Codex review (2026-07-01) + adjudication

The adversarial codex pass (gpt-5.5, xhigh) was **cut off before a formal Go/No-Go** (it exhausted
its output budget mid-investigation — a known headless-codex truncation). Before it died it surfaced
one thread, which I verified and **expanded**; the finding is real and enlarges the blast radius this
ADR originally undercounted:

**The `route_id` vocabulary is not just the stored setting — it is an externalized, client-facing
contract, and it is shared with a second orchestrator:**
- **Client WS contract.** The websocket session-ack emits `fallback_candidates` with `route_id`s, and
  `test_transcripts_ws_session_ack_includes_live_fallback_candidates` / `test_transcripts_ws_contract.py`
  lock that shape. Per ADR-059 the WS event contract is sacred.
- **Runtime events.** `stt_http_transcriber.py` tags ~10 live events with `route_id`; these reach the client.
- **Frontend consumers.** `audio/audioMessages.js`, `audio/useLiveSessionStatus.js`,
  `home/homeServiceStatusLogic.js`, `settings/settingsSummary.js` all read route ids.
- **Import path shares the setting.** `services/provider_selection.py` (file-import STT, separate from
  live) also orders by `fallback_priority` with route ids. Changing the vocabulary touches BOTH orchestrators.

**Consequence for this decision:** Option B ("true engine-list fallback") is materially more invasive than
this ADR first stated — it is a **client WS-contract change + a two-orchestrator rewrite + a frontend
status-display change + several contract-test rewrites**, not a single-resolver edit. That re-weights the
options:

- **Option A (UI-only unified presentation) is now the recommended path.** Keep `route_id`s as the backend
  and WS contract vocabulary untouched; make the *Speech-to-text section* present primary engine + fallback
  routes as one ranked list, mapping route ids to friendly labels for display and writing back the existing
  `provider` + `live_fallback_priority` (route) fields. This closes the operator confusion (one ranked list)
  **without** touching the live/import orchestrators, the WS contract, or the contract tests. Reorder applies
  to the route portion; "make primary" among true engines still writes `provider`.
- **Option B remains possible** but should be treated as a larger, separately-scoped effort with its own
  contract-migration plan (versioned WS ack, dual-vocabulary frontend, import-path parity), not folded into
  the settings redesign.

**Status change:** pending operator decision between A (recommended, low-risk, UI-only) and B (deferred,
larger). Implementation of either is still gated on a reachable backend for a live smoke test.
