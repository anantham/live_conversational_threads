# ADR-013 Full Intent-Signal Roadmap

Date: 2026-07-04
Status: Phase 2 review tray slice landed; annotation, merge, lull cards, and formalization remain future

## Question

What remains to build the full ADR-013 prayer / intent-signal lifecycle, and how far along is the
repo today?

## Current State

| Slice | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Schema and migration | Done | `models/analysis.py`, `alembic/versions/add_intent_signals.py` | `intent_signals` and `intent_signal_sightings` exist with lifecycle/formalization fields. |
| Contract C validation | Done | `services/intent_signal_persistence.py`, `tests/unit/test_intent_signal_persistence.py` | Validates LLM output and drops invalid/low-confidence items. |
| Persistence helper | Done | `persist_intent_signals()` | Creates new signals and sightings; unit covered. |
| Feature flag | Present | `INTENT_SIGNAL_DETECTION_ENABLED` | Exists but defaults off. |
| Contract C prompt and LLM runner | Done for live backend | `services/intent_signal_detector.py`, `tests/unit/test_intent_signal_detector.py` | Runs through provider fallback, accepts JSON arrays, and validates with Contract C. |
| Live STT wiring | Done behind flag | `stt_ws_session.py` calls the detector on final transcript segments when `INTENT_SIGNAL_DETECTION_ENABLED=true` | Uses a separate DB session inside the background task to avoid racing graph persistence. |
| Analysis-event durability | Partially done | `thread_session_events` via `record_thread_event()` | Detection errors and non-empty detection passes are durable; there is still no dedicated `analysis_events` table. |
| IndrasNet live-card bridge | Separate explicit-command path | Asus `TemporalCoordination` `origin/main`: `agents/routes/lct_prayers.py`, `core/attention_router.py` | Latest bridge recognizes explicit Fetch and returns `decision`/`cards`; non-explicit text becomes a low-confidence no-prayer routing decision. |
| Query API | Done | `intent_signals_api.py`, `tests/unit/test_intent_signals_api.py` | `GET /api/conversations/{id}/intent-signals` returns owned conversation signals plus owner-scoped sightings. |
| Minimal intent-signal tray | Done | `IntentSignalsTray.jsx`, `intentSignalsApi.js`, `ViewConversation.jsx` | Saved conversation view can inspect persisted signals and mark them ready or abandoned. |
| Lifecycle review actions | Partial | `PATCH /api/conversations/{id}/intent-signals/{signal_id}` | Ready/abandon landed; annotation UI, explicit reject notes, duplicate merge, and formalization review remain future. |
| Lull resume cards | Future | README marks future; ADR-013 describes candidate ordering | Should wait until enough persisted signals exist to evaluate quality. |
| Formalization bridge | Roadmap | `/generate_formalism/` endpoint removed; toolbar slot placeholder | Keep as roadmap after detection/tray quality is proven. |

## Roadmap

### Phase 0 - Contract clarification

- Resolved on 2026-07-04 after inspecting the Asus IndrasNet `origin/main`
  checkout: ADR-013 Contract C remains LCT-owned for generic pre-formal intent
  signals. IndrasNet's `/api/lct/prayers/detect` route is the explicit
  low-blast Fetch/card bridge, not the generic Contract C detector.
- Define how `analysis_events` should be represented now that the ADR references a table that does
  not appear to exist.
- Keep low-blast Fetch/fact-check cards separate from generic intent signals:
  Fetch cards use IndrasNet retrieval; fact-check cards are local LCT logic;
  generic ADR-013 signals persist to `intent_signals`.

Exit criteria: a short ADR-013 amendment or successor ADR describing ownership, event logging, and
MVP prayer types. Current implementation chose LCT-owned generic intent-signal detection for the
first backend slice, while keeping IndrasNet live-prayer cards as a separate explicit command path.

### Phase 1 - Backend detection runner

- Add a Contract C prompt or service-owned detector. **Done for live backend.**
- Add an LLM runner behind `INTENT_SIGNAL_DETECTION_ENABLED`. **Done.**
- Call it after final transcript persistence in live STT. **Done.**
- Persist validated results with `persist_intent_signals()`. **Done.**
- Emit durable analysis/error events for parse failure, dropped item count, model, latency, and
  created/sighting counts. **Done via `thread_session_events`; dedicated `analysis_events` remains open.**
- Wire import processing only if explicitly chosen. **Not done.**

Tests: detector and persistence unit tests pass; still need a live websocket integration test with
the feature flag enabled.

### Phase 2 - Query API and review tray

- Add read APIs for conversation/session intent signals. **Done for saved conversations.**
- Add lifecycle mutation APIs: mark ready and abandon are **done**; annotate/reject notes and
  duplicate merge remain future.
- Build a calm conversation-side tray showing raw text, context, source utterance, sightings, and
  status. **Minimal tray with ready/abandon actions done.**
- Keep all actions human-confirmed.

Tests: API auth/validation/lifecycle tests and frontend service tests pass. Still need browser smoke
for tray load and ready/abandon clicks against a seeded conversation.

### Phase 3 - Cross-session accumulation quality

- Implement duplicate/sighting matching against prior signals.
- Add reviewer-visible confidence and context.
- Measure false positives and duplicate misses on real conversations.
- Do not auto-promote until measured quality is acceptable.

Tests: behavioral matching fixtures; regression tests for duplicate creation, low-confidence drops,
and sighting_count updates.

### Phase 4 - Lull resume cards

- Add a conservative lull detector or reuse existing session timing signals.
- Query active/accumulating signals ordered by salience and last sighting.
- Generate or template re-entry phrasing.
- Surface as optional cards only; dismissal and usefulness feedback should be stored.

Tests: card candidate ordering, no-card when confidence/data is weak, UI smoke for dismiss/accept.

### Phase 5 - Formalization bridge

- Restore formalization as a new reviewed flow, not the removed endpoint.
- Human marks signal ready.
- System assembles raw text, context window, and sightings.
- LLM drafts candidate formal statement.
- Human accepts/edits/rejects/abandons.
- Accepted output creates or links a Claim/Node and updates `formalized_claim_id` or
  `formalized_node_id`.

Tests: lifecycle API tests, no auto-promotion, claim/node creation integrity, rejection returns to
accumulating with a note.

## Decision Point

The repo is now past "schema plus helper": the live backend can run Contract C behind a feature flag,
persist validated signals, expose/read them in a minimal saved-conversation tray, and support the
first human lifecycle actions (`ready`, `abandoned`). The latest IndrasNet bridge does not replace
this path; it only supports explicit Fetch/card actuation. A realistic next build slice is a browser
smoke test plus annotation/rejection notes if the review experience feels useful. Lull cards and
formalization should remain future until we have real persisted signals to inspect.
