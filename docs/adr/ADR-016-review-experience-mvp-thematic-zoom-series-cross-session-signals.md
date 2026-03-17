# ADR-016: Review Experience MVP — Thematic Zoom Integration, Conversation Series, and Cross-Session Intent Signal Linking

**Date:** 2026-03-17
**Status:** Approved
**Group:** interaction + data
**Extends:** ADR-013 (Intent Signals / Prayers)

---

## Issue

The primary value of LCT lands in the **review experience** — returning to a conversation
days later and recovering structure, context, and developing intuitions. The live recording
path should be reliable but minimal; the investment goes into review.

Three capabilities are missing from the review experience today:

1. **Multi-scale navigation is siloed.** Thematic zoom (6 discrete abstraction levels)
   exists as a standalone component (`ThematicView.jsx` + `components/thematic/`) but has
   no route in `AppRoutes.jsx`. The default conversation view (`/conversation/:id`) shows
   only the MinimalGraph — the raw sequential node-link structure. A reviewer who wants
   semantic abstraction levels must find ThematicView through an indirect path that
   doesn't currently exist in the router.

2. **Conversations are isolated islands.** There is no way to group related conversations
   ("Sahil alignment discussions", "groundless theory of change"). The Browse page shows a
   flat chronological list. A reviewer tracking a developing line of inquiry across 5–10
   conversations has no structural support for that grouping.

3. **Intent signals don't link across sessions.** ADR-013 defined the `intent_signals` and
   `intent_signal_sightings` schema with cross-session accumulation fields
   (`sighting_count`, `last_sighted_conversation_id`). But there is no detection mechanism
   that recognizes when an IntentSignal in conversation A and an IntentSignal in
   conversation B are sightings of the same developing intuition. Each conversation's
   signals are currently opaque to other conversations.

Without these three, the review experience is: open a single conversation, look at one
graph view, close it, open the next conversation, start from scratch. The pre-formal layer
is being captured but not accumulated.

---

## Context

### User profile (near-term)

Solo theory-builder recording intellectually dense conversations with collaborators.
Imports transcripts post-hoc. Reviews days later. The scarce resource is not transcription
— it's recovering the structure and developing intuitions that emerged during conversation.

Multi-user shared views, live graph interaction, and formal verification bridges are
deferred.

### What exists today

| Capability | Status | Location |
|---|---|---|
| MinimalGraph (sequential node-link) | Working | `ViewConversation.jsx` |
| ThematicView (6-level semantic zoom) | Working, no route | `ThematicView.jsx` + `components/thematic/` (not in `AppRoutes.jsx`) |
| ContextualGraph (relationship network) | Working | Separate route |
| StructuralGraph (DAG layout) | Working | Separate route |
| IntentSignal + IntentSignalSighting models | Migrated | `models/analysis.py`, ADR-013 |
| Contract C (LLM detection) | Specified | ADR-013, not yet implemented |
| Conversation series / grouping | None | — |
| Cross-session signal linking | Schema ready, no detection | — |

### Key constraint

The thematic zoom infrastructure already works. The conversation series is a trivial data
model addition. The cross-session signal linking extends existing ADR-013 entities. None of
these require new architectural primitives. The decision is about **sequencing and wiring**,
not about building new systems.

---

## Decision

Build the review experience MVP in three sequential moves. Each move is independently
shippable and valuable; each sets up the next.

### Move 1: Thematic Zoom in the Default View (frontend wiring)

Add a **tab/toggle** to `ViewConversation.jsx` that switches between MinimalGraph
(temporal) and ThematicView (semantic). The two views are genuinely different analyses —
MinimalGraph preserves conversational flow; ThematicView re-clusters by semantic
similarity. Neither approximates the other well. A toggle preserves both.

**Specification:**

- Segmented control or tab bar: `Flow | Themes` (two modes).
- `Flow` is the current MinimalGraph — the default on first load.
- `Themes` lazy-loads the ThematicView component and its data
  (`/api/conversations/{id}/themes?level=n`).
- Selected tab persists in URL query param (`?view=themes&level=3`) so that links to
  specific views are shareable and browser-back works.
- Node selection state resets on tab switch (the node IDs differ between views).
- No standalone `/thematic/:id` route exists today; none is created. ThematicView is
  accessed exclusively through this tab.

**Empty-state handling (Themes tab):**

`ThematicView.jsx` currently shows a dead-end message ("Click 'Generate Thematic View'
in the Analysis menu") that references a menu `ViewConversation.jsx` does not expose.
Move 1 must replace this empty state with an actionable one:

- When no thematic levels exist for the conversation, the Themes tab shows a
  "Generate thematic structure" button that calls the existing
  `/api/conversations/{id}/themes/generate` endpoint directly.
- A loading indicator replaces the button during generation.
- On success, the ThematicView renders the newly generated levels.
- On failure, an error message with retry option.

This is the minimum fix to make the Themes tab self-contained — it must not depend on
UI surfaces outside the ViewConversation page.

**What this does NOT include:**
- Continuous zoom (the 6 discrete levels are sufficient).
- Timeline scrubber (a future third tab/mode, not part of this move).
- Unifying node IDs across views (architecturally hard, low value now).

### Move 2: Conversation Series (data model + Browse UI)

Add a lightweight grouping mechanism so conversations can be tagged into named series.

**Schema:**

```sql
CREATE TABLE series (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,          -- "Tracking the teleattention → steam → institutional design thread"
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE conversation_series (
    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    series_id        UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    added_at         TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (conversation_id, series_id)
);

CREATE INDEX idx_conversation_series_series ON conversation_series(series_id);
```

Many-to-many: a conversation can belong to multiple series (an alignment discussion
might be tagged both "Sahil conversations" and "teleattention theory").

**UI:**

- Browse page: filter/group by series. Series appears as a collapsible group header.
- Conversation detail: shows series tags; inline add/remove.
- Series management: create/rename/describe from Browse page. No separate admin route.

**Signal-to-series scoping rule:**

Intent signals belong to conversations, not to series. Series-scoped queries mean
"show me signals from conversations that are members of this series." If a conversation
is in two series, its signals appear in queries for both. This is correct: the signal
is about what happened in the conversation, and the conversation legitimately belongs
to both research threads.

Concretely:
- Resume cards for a series show signals from all conversations in that series.
- The similarity search endpoint (`GET /api/intent-signals/{id}/similar`) accepts an
  optional `series_id` param that restricts candidates to signals from conversations
  in that series. Without `series_id`, it searches all conversations.
- No `series_id` FK is added to `intent_signals`. The join path is always
  `intent_signals → conversations → conversation_series → series`.

This means a signal can appear in resume cards for multiple series. That's a feature:
a cross-pollination insight ("this thing from the Sahil thread also showed up in the
groundless thread") is exactly the kind of connection the system should surface, not
suppress. If this becomes noisy at scale, the fix is relevance ranking per series
context, not exclusion.

**What this does NOT include:**
- `active_intent_signals` on the series entity. The link between a series and its
  signals should emerge from the data (Move 3), not be manually maintained.
- Ordering within a series (chronological by `started_at` is sufficient).
- Series-level analytics or summaries (future work).

### Move 3: Cross-Session Intent Signal Linking (extend ADR-013)

Enable the system to recognize that IntentSignals across different conversations are
sightings of the same developing intuition.

**UI surface: Prayers tab on ViewConversation**

Move 1 adds `Flow | Themes` tabs. Move 3 adds a third tab: `Flow | Themes | Prayers`.

The Prayers tab shows:
- List of intent signals detected in this conversation (from `intent_signals` where
  `conversation_id` matches, plus any `intent_signal_sightings` referencing this
  conversation).
- Each signal card shows: `raw_text`, `context_window`, `status`, `sighting_count`,
  `detection_confidence`.
- Clicking a signal expands it to show: all sightings across conversations, the
  "similar signals" panel (see below), and manual link/unlink actions.
- A resume card banner at the top (if the conversation belongs to a series) showing
  active/accumulating signals from sibling conversations in the same series.

When no intent signals exist for the conversation (Contract C not yet running, or no
signals detected), the tab shows an empty state: "No prayers detected yet. Prayers are
pre-formal intentions — hunches, gestures, half-formed connections — that the system
captures during analysis." Plus a "Create manually" action for the user to tag an
utterance range as an intent signal. This ensures the tab is useful even before
Contract C is implemented.

**Mechanism — two complementary paths:**

**(a) Manual linking (v1, ship first):**

When reviewing a conversation's intent signals in the Prayers tab, the user can:
- See a list of "similar signals from other conversations" (ranked by embedding
  similarity of `raw_text` + `context_window`).
- Confirm a match → **merge** (see merge semantics below).
- Reject a match: logged as negative training data for future auto-linking.

This requires:
- Computing and storing embeddings for `intent_signals.raw_text` (piggyback on the
  existing claim embedding infrastructure in `models/analysis.py`).
- A similarity search endpoint: given a signal, return top-N similar signals from
  other conversations, optionally scoped to a series.

**Merge semantics (P1):**

The current persistence code (`intent_signal_persistence.py:162`) makes a binary
decision at write time: `is_new=True` creates a new `IntentSignal` row;
`is_new=False` creates a sighting on an existing row. But manual linking happens
*after* both signals have already been persisted as separate `IntentSignal` rows
(one per conversation). Confirming a match means merging two already-created rows.

ADR-013 treats `IntentSignal` rows as **immutable first-emergence records** — `raw_text`
and `context_window` must not be edited post-detection. This rules out deleting or
mutating the child row.

**Merge rule: absorb via status transition.**

When the user confirms that signal B (child) is a re-appearance of signal A (parent):

1. Create an `IntentSignalSighting` row linking signal A to signal B's conversation,
   with `utterance_ids` and `context_note` copied from signal B's fact-layer fields.
2. Set signal B's status to `'merged'` (new status value, added to the constraint).
3. Add a `merged_into_id` column (nullable FK → `intent_signals`) on signal B,
   pointing to signal A.
4. Update signal A's denormalized fields: `sighting_count += 1`,
   `last_sighted_at`, `last_sighted_conversation_id`, `status → 'accumulating'`.
5. Signal B remains in the database as an immutable record of its first detection,
   but queries for active/accumulating signals exclude `status='merged'`.

**Schema addition for merge:**

```sql
ALTER TABLE intent_signals ADD COLUMN merged_into_id UUID
    REFERENCES intent_signals(id) ON DELETE SET NULL;
-- Add 'merged' to status constraint
ALTER TABLE intent_signals DROP CONSTRAINT IF EXISTS intent_signals_status_check;
ALTER TABLE intent_signals ADD CONSTRAINT intent_signals_status_check
    CHECK (status IN ('active', 'accumulating', 'ready', 'formalized', 'abandoned', 'merged'));
CREATE INDEX idx_intent_signals_merged ON intent_signals(merged_into_id)
    WHERE merged_into_id IS NOT NULL;
```

**Undo:** If the user later decides the merge was wrong, set signal B's status back to
`'active'`, clear `merged_into_id`, delete the corresponding sighting row, and
decrement signal A's `sighting_count`. This is a reversible operation.

**(b) Auto-linking (v2, after calibration):**

Once manual linking has produced enough confirmed matches to measure precision:
- After Contract C detection, automatically check new signals against existing signals
  (embedding similarity > threshold).
- High-confidence matches (> 0.85) auto-create sightings.
- Medium-confidence matches (0.6–0.85) surface as suggestions for human confirmation.
- Series membership is a prior: signals from conversations in the same series get a
  similarity boost (via the `conversation_series` join, not a direct FK).

Auto-linking is **not part of this ADR's rollout**. It requires calibration data from
manual linking. This ADR ships manual linking only.

**Resume cards (connecting Move 3 to the review experience):**

When opening a conversation that belongs to a series, the system surfaces a "resume
card" showing:
- Active/accumulating intent signals from other conversations in the same series.
- Ordered by `salience DESC`, `last_sighted_at DESC`.
- Each card shows: `raw_text`, sighting count, which conversations it appeared in,
  and the suggested re-entry phrasing from ADR-013.

This is the payoff: before a call with Sahil, you open the "Sahil alignment discussions"
series and see "these 3 intuitions were developing across your last 4 conversations."

---

## Positions Considered

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Build prayer detection pipeline first (Contract C implementation) | Unlocks the full ADR-013 vision | No review UX improvement; signals detected but not surfaceable; highest risk |
| B | Build cross-session features first (series + linking) | Addresses the "isolated islands" pain | No multi-scale navigation; conversations are grouped but still hard to explore individually |
| C | Build thematic zoom integration first, then series, then linking (chosen) | Each move independently valuable; cheapest move first; each sets up the next; risk is spread across three small deliverables | Three separate PRs; full prayer vision takes three moves to reach |
| D | Unified view (merge MinimalGraph and ThematicView into one smooth experience) | Seamless UX | Architecturally expensive; loses the distinct value of each view; premature unification |

**Chose C** because the risk gradient matches the effort gradient. Move 1 is pure frontend
wiring (days). Move 2 is a trivial schema addition (days). Move 3 is the first real
extension of ADR-013 (1–2 weeks). Each delivers user-facing value on its own.

---

## Assumptions

1. Thematic levels may not exist for all conversations. The Themes tab handles this with
   an in-tab "Generate thematic structure" button (see Move 1 empty-state spec). The
   existing `ThematicView.jsx` empty state ("Click 'Generate' in the Analysis menu")
   references a menu that `ViewConversation.jsx` does not expose; Move 1 replaces it.
2. Embedding infrastructure for claims (`models/analysis.py::Claim.embedding`) can be
   reused for intent signal similarity search with minimal adaptation.
3. The user will manually create series and tag conversations for now. Auto-series-detection
   (clustering conversations by topic) is a future feature.
4. Move 3 is useful even without Contract C implemented — the Prayers tab supports
   manual creation of IntentSignal rows (tag an utterance range as a prayer) and manual
   linking across conversations. The full value requires Contract C to populate signals
   automatically, but the review/linking UX can be validated first.

---

## Constraints

1. **No new graph primitives.** Moves 1–2 wire existing infrastructure; Move 3 extends
   existing ADR-013 entities. No new visualization types or analysis models.
2. **No live-path changes.** All three moves improve the review experience. The live
   recording path is untouched.
3. **Backward-compatible.** Conversations without series tags or intent signals display
   exactly as they do today. No migration of existing data required (series/signals are
   additive).

---

## Consequences

**Positive:**
- The review experience becomes multi-scale: shift between temporal flow and semantic
  themes without leaving the page.
- Developing lines of inquiry become visible as named series rather than disappearing
  into a flat chronological list.
- Intent signals start accumulating across sessions, fulfilling the core promise of
  ADR-013 and VISION.md's prayer-tracking mission.
- Resume cards give the reviewer a "previously on..." summary before entering a
  conversation, reducing cold-start friction.

**Negative:**
- Move 1 adds a lazy-loaded component to ViewConversation, increasing bundle size for
  that route (mitigated by code-splitting).
- Move 2 introduces a new table and join table; series management is a new UX surface
  to maintain.
- Move 3 (embedding similarity search) adds compute cost per intent signal. For the
  expected volume (10s of signals across 10s of conversations), this is negligible.
- Auto-linking (v2) is explicitly deferred, which means cross-session accumulation
  requires manual effort until calibration data justifies automation.

---

## Rollout Plan

### Move 1: Thematic Zoom Integration

1. Add tab bar component to `ViewConversation.jsx` (`Flow | Themes`).
2. Lazy-load `ThematicView` and its hooks on Themes tab selection.
3. Replace `ThematicView.jsx` empty state: remove "Analysis menu" reference, add
   in-tab "Generate thematic structure" button calling the generate endpoint.
4. Sync selected tab + level to URL query param (`?view=themes&level=3`).
5. Test: switching tabs preserves conversation context; back-button works; deep links
   work; generate-from-empty-state works.

**PR scope:** ~250 LOC frontend (tab bar + empty-state fix), 0 backend changes.

### Move 2: Conversation Series

1. Alembic migration: `series`, `conversation_series` tables.
2. FastAPI endpoints: CRUD for series, add/remove conversation from series.
3. Browse page: series filter/grouping UI, inline series management.
4. ViewConversation header: series tag display and inline add/remove.

**PR scope:** ~100 LOC backend (migration + endpoints), ~200 LOC frontend.

### Move 3: Cross-Session Intent Signal Linking

1. Alembic migration: add `embedding` column and `merged_into_id` FK to
   `intent_signals`; add `'merged'` to status constraint.
2. Implement embedding computation for intent signals (reuse claim embedding pipeline).
3. Similarity search endpoint: `GET /api/intent-signals/{id}/similar?series_id=&limit=`.
4. Merge endpoint: `POST /api/intent-signals/{child_id}/merge-into/{parent_id}` —
   implements the absorb-via-status-transition rule.
5. Undo-merge endpoint: `POST /api/intent-signals/{child_id}/unmerge`.
6. Add Prayers tab to `ViewConversation.jsx` tab bar (extending Move 1's `Flow | Themes`
   to `Flow | Themes | Prayers`).
7. Prayers tab: signal list, signal detail with sightings, "similar signals" panel,
   merge/unmerge actions, manual signal creation, resume card banner.

**PR scope:** ~200 LOC backend (migration + endpoints + merge logic), ~400 LOC frontend
(Prayers tab + resume cards). Depends on Move 1 (tab bar exists), Move 2 (series
scoping for similarity search), and ADR-013 rollout step 1 (IntentSignal migration
already applied).

---

## Success Criteria

1. **Move 1:** A reviewer can switch between Flow and Themes views on the same page in
   < 1 second, with URL deep-linking working.
2. **Move 2:** Conversations can be grouped into series and filtered on the Browse page.
   Series with > 3 conversations show a meaningful grouping.
3. **Move 3:** Given a manually-created intent signal, the system surfaces similar signals
   from other conversations with > 0.7 precision (measured against human judgment on
   first 20 manual link attempts).
4. **End-to-end:** Before a recurring conversation, the reviewer can open the series,
   see a resume card with developing intent signals, and enter the conversation with
   context from prior sessions.

---

## Related

- `docs/VISION.md` — mission, four-layer architecture, prayer concept
- `docs/adr/ADR-013-intent-signals-prayers-schema.md` — IntentSignal/Sighting schema,
  Contract C, formalization bridge
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md` — conversation schema
- `lct_app/src/components/thematic/` — existing thematic zoom infrastructure
- `lct_app/src/pages/ViewConversation.jsx` — current review view (Move 1 target)
- `lct_python_backend/models/analysis.py` — IntentSignal, Claim (embedding precedent)
