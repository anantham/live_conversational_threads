# ADR-033: Consumption Prayer Matching in the Live Conversation Path

**Status**: Accepted (2026-05-24)
**Author**: anantham + Claude
**Related**: ADR-013 (intent_signals schema, shared with IndrasNet); supersedes the design sketch in commit message bodies and the 5 memory entries `lct-indras-net-shared-primitive`, `indras-net-position-in-stack`, `indrasnet-retrieval-endpoints`, `graph-aggregation-ux-direction`, `live-recording-no-auto-consolidation`.

## Context

LCT transcribes live conversation into a thread graph in near real-time. The graph is *production* output — it captures what was said and the structure of what was meant. **Consumption** is the other side of the same coin: at the moment a speaker reaches for some past intent ("what was that thing we wanted to discuss…"), the listening AI should be able to surface it instead of leaving the speaker to fumble. Production prayers (held intentions) live in IndrasNet's prayer store; LCT's job is to detect the moment a speaker is consuming — asking for — one of them, and to deliver it before the moment passes.

Two cross-repo facts shape this:

1. **IndrasNet owns the prayer corpus and the per-contact Obsidian notes.** When a Confirmed Remind/Connect prayer is approved, IndrasNet appends a bullet under `## Pending discussions` in each participant's contact note. The `GET /api/contacts/{ref}/pending-discussions` endpoint reads that section back. LCT calls IndrasNet over HTTP (Tailscale, `100.81.65.74:7777`); LCT never reads the Obsidian vault directly.
2. **Consumption has two distinct triggers.** *Manual* — the user drag-selects a sentence in the live transcript pane and clicks a "Show agenda with [contact]" toolbar slot. *Auto* — the live STT pipeline runs a phrase detector on each finalized segment and fires when the speaker verbally invokes the agenda ("what was pending with Sahil", "I pray to see the agenda"). The manual path is the safety net for false negatives on the auto path; both must reach the same render surface (`ConsumptionPrayerChip` + `ConsumptionPrayerDrawer`).

User formulation (verbatim, 2026-05-18): *"the key is interrupting a real time conversation with what is asked from the listening ai… it's not action slots but prayer types, one would be a formalism prayer, send to prayer, recommend prayer both to store it for future or to fetch something to discuss, remind prayer to defer some plan etc — for MVP we can focus on one."*

## Decision

A two-trigger architecture that funnels into one rendering surface. Manual is shipped; auto is built but feature-flagged off by default.

### Part A — Manual trigger (shipped, the MVP)

**Flow:** user selects text → floating toolbar (`TranscriptSelectionToolbar`) → "Show agenda with [contact]" → `POST /api/conversations/{id}/recommend-consumption-query` → LCT proxies `get_pending_discussions` to IndrasNet → response renders in chip + drawer.

**Why HTTP, not WS, for manual:** the user is clicking a button. The request/response shape fits; round-trip latency is ≤1 IndrasNet hop; no need for the connection-state machinery of WS for a one-shot lookup. The HTTP response body carries `source: "manual"`, `triggered_at`, and the full IndrasNet body. Frontend auto-opens the drawer when `item_count > 0` — user initiated, so a visible result is not an interruption.

**Toolbar contact picker:** sorts mentioned-in-selection → conversation contact → A–Z. Backed by `/api/consumption-prayer/known-contacts` which is in turn backed by a cached read of IndrasNet's contact list (the cache is itself a separate concern — see `services/contacts_cache.py`).

### Part B — Auto-detect trigger (built, off by default)

**Hook point:** `stt_ws_session.py:_persist_event`, in the `event_type == "final"` branch. The canonical "complete utterance just landed" moment. A fire-and-forget `asyncio.create_task` runs the detector + lookup; the live STT path is never blocked.

**Detector:** `services/agenda_query_detector.py` — substring match against ~50 hand-curated phrases in 6 families (pray/wish, agenda, pending, reach-back, remind, list), plus name-grounded templates expanded per known contact (e.g. "pending with {NAME}"). Two-pass with name-grounded first — the specific overrides the general.

**Runner:** `services/consumption_match_runner.py` — pure async function with injected `fetch_pending_discussions` and `send_ws_event`. Owns dedupe (`ConsumptionMatchDeduper`, 30s per `(phrase, contact)` to suppress refinement-pass re-emits) and IndrasNet error translation (all failures swallowed, logged — never propagate to the live task).

**WS event shape:** `{type: "consumption_match", source: "auto", matched_phrase, match_source, triggered_at, conversation_id, ...IndrasNet body}`. Unified shape with the manual HTTP response (modulo the discriminator) so the frontend handler can route both into the same state setters.

**Frontend UX on auto-match:** chip updates with item count; drawer does NOT auto-open. User clicks the chip when ready. Rationale: auto-detect is the AI surfacing — interrupting visually during live conversation is worse than missing a beat. Manual stays auto-open because the user initiated.

**Feature flag:** `AGENDA_QUERY_DETECTOR_ENABLED` (off by default). Both `agenda_query_detector.is_enabled()` and `consumption_match_runner.should_run()` gate on it. WS session checks before scheduling the task — no overhead when off.

### Part C — Contact resolution policy

Two sources of "who is this query about":

1. **Name-grounded match's `matched_contact_name`** — the speaker explicitly named someone. Always wins.
2. **Conversation's selected participant** (`self._consumption_contact_ref`) — the fallback for contact-agnostic phrases ("what was pending again").

If neither is set, the auto-detect skips the lookup. Logged at INFO; not an error. Manual trigger always carries `contact_ref` in the request body, so this only affects auto.

### Part D — Privacy gate

Per the `indrasnet-external-llm-ok-privacy-gate` memory: IndrasNet contacts carry a `0/1 external_llm_ok` flag. LCT respects it for any downstream LLM use (e.g. if future versions LLM-rerank matches). For the present matching path — substring detector + Obsidian read — no LLM is invoked, so the flag is not consulted on this path. When the path acquires an LLM step, the contact's flag MUST gate the call before shipping any name/transcript/voice clip.

## Known Limitations

1. **Contact cache window.** The known-contacts list is the picker's top-50 by recent activity. Speakers naming a contact outside that window won't fire name-grounded; contact-agnostic phrases still work if a participant is set.
2. **Historical participant gap.** Confirmed Remind/Connect prayers from before this feature only have "Self" as participant. The auto-append-to-contact-note hook (IndrasNet `_auto_execute_after_approve`) populates organically only for NEW conversations. Backfill of historical participants is an IndrasNet-side task.
3. **No participant-ref auto-population yet.** `self._consumption_contact_ref` is initialized to None in the WS session and not yet set from the participant picker. Until wired, contact-agnostic auto-matches in a session with a chosen participant will skip. Manual trigger is unaffected.
4. **Single prayer type.** Recommend-consumption is the only active toolbar slot. Formalism / SendTo / Remind / Connect are documented placeholders in `TranscriptSelectionToolbar` — they'll come back when their semantics are designed.

## Alternatives Considered

- **LLM-based intent classifier instead of substring detector.** Rejected for MVP — every false-positive interrupts. Substring is deterministic, debuggable, and per-deployment tunable via `AGENDA_QUERY_PATTERNS`. Revisit when explicit phrases consistently underfit real speech.
- **Topic-similarity matching against the prayer corpus (the `match_prayers` path, /api/prayers/match).** Built and mothballed (task #1 in the task list). The Obsidian per-contact note is a higher-signal source than topic similarity — Confirmed prayers were already curated by the user. Topic similarity comes back when we want cross-contact recommendation ("you have an open thread on X with someone — want to bring it up?").
- **Implicit consumption detection.** Built and mothballed (`consumption_trigger.py`, 41 tests pass, intentionally uncommitted). The LLM-gated implicit path was supposed to detect when the speaker was "reaching for" a prayer without verbal invocation. Deferred because the explicit verbal trigger is sufficient for the MVP and far cheaper.

## Consequences

- LCT now has a direct functional dependency on IndrasNet for a feature that surfaces in the conversation UI. When IndrasNet is unavailable, the chip stays idle on the manual path (HTTP 502 surfaced as an error in the chip's error state) and silent on the auto path (logged warning, no WS emission). The conversation itself is not blocked.
- The contacts cache (`services/contacts_cache.py`) is now load-bearing for two surfaces: the picker AND the agenda detector's name-grounded expansion. Cache staleness affects both — but stale data is better than empty here, so this is acceptable.
- The dedupe window is per-WS-session. If a user toggles the feature flag or restarts a recording, dedupe state resets. This is correct: a deliberate restart is a deliberate "start over."
- `consumption_match_runner` is the canonical extension point for adding more consumption prayer types. New types should add a `type` discriminator inside the runner (or a sibling module) and reuse `ConsumptionMatchDeduper` keyed on `(type, phrase, contact)`.

## Verification

- 18 unit tests in `test_consumption_match_runner.py` cover wiring, contact resolution, error swallowing, dedupe, and feature-flag gating.
- 51 unit tests in `test_agenda_query_detector.py` cover the detector itself.
- Manual end-to-end was verified against the live IndrasNet at `100.81.65.74:7777` after the 2026-05-18 `detect_types` fix deployed.
- Auto-trigger end-to-end requires `AGENDA_QUERY_DETECTOR_ENABLED=true` plus a live WS conversation; it has been smoke-tested with synthetic finalized segments but not yet exercised in a real recording session.
