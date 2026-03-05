# ADR-013: Intent Signals (Prayers) Schema and Layer 1→2 Formalization Bridge

**Date:** 2026-03-05
**Status:** Approved
**Group:** data + interaction
**Supersedes:** Gap identified in ADR-010 Amendment (2026-03-05)

---

## Issue

The schema has no first-class primitive for a **prayer** — a pre-formal intention
gestured at in conversation before it is nameable as a claim or a thread.

Current workarounds:
- Forcing prayers into `threads` (with low salience) prematurely names them, losing
  the specificity of their pre-formal context.
- Forcing prayers into `claims` imposes structure (factual/normative/worldview) before
  the speaker has any such structure in mind.
- Both approaches contradict the core principle: **preserve specificity, resist abstraction**.

Without a first-class primitive, the system cannot:
1. Track how a pre-formal intention accumulates context across sessions.
2. Surface prayers at lulls with their full conversational surroundings intact.
3. Offer formalization at the right moment without forcing it prematurely.

---

## Context

VISION.md defines the mission as "preserve the pre-formal layer of human intellectual
work." Prayers are the central primitive of that layer:

> A theory-building mathematician saying "I keep noticing this pattern across three
> examples, I don't know what it is yet" is not wasting time — that gesture is the
> actual creative work. The formalization comes later; the insight comes here.

The four-layer architecture assigns Threads ownership of Layers 1–2:

```
Layer 0  CONVERSATION     Pre-formal, gestural. Prayers emerge here.
         ↕
Layer 1  THREADS          Captures intent signals with context.
                          Tracks accumulation across sessions.
         ↕
Layer 2  JUST-IN-TIME     When an intent signal is ready, offers a candidate
         FORMALISM        formal statement for human review.
```

This ADR specifies:
1. The `intent_signals` table (the prayer primitive).
2. The `intent_signal_sightings` join table (cross-session accumulation).
3. The LLM detection contract (what the model outputs; how it maps to DB columns).
4. The Layer 1→2 formalization bridge (lifecycle and human review mechanism).

---

## Decision

### 1. Naming

The primitive is called **intent signal** in the database (`intent_signals`,
`intent_signal_sightings`) and **prayer** in user-facing language (UI, docs, vision).
This separates domain language from technical identifiers while preserving the
expressiveness of the prayer concept in product communication.

### 2. Schema: `intent_signals`

```sql
intent_signals
├── id                        UUID PRIMARY KEY
├── conversation_id           UUID FK → conversations  -- first emergence
│
-- The prayer itself (immutable after detection; preserves specificity)
├── raw_text                  TEXT NOT NULL   -- exact words from transcript
├── context_window            TEXT NOT NULL   -- surrounding utterances verbatim
├── speaker_id                TEXT NOT NULL   -- who voiced it
│
-- Fact-layer anchors (immutable)
├── source_utterance_ids      UUID[]          -- utterances containing the signal
├── source_node_id            UUID FK → nodes (nullable) -- active node at emergence
│
-- Lifecycle
├── status                    TEXT NOT NULL
│     -- 'active'       : detected, tracking
│     -- 'accumulating' : reappeared in ≥1 further sessions
│     -- 'ready'        : human has marked it ready for formalization
│     -- 'formalized'   : graduated to a claim or thread
│     -- 'abandoned'    : human explicitly dropped it
├── emerged_at                TIMESTAMPTZ NOT NULL
│
-- Accumulation summary (denormalized for fast display; source of truth is sightings)
├── sighting_count            INTEGER DEFAULT 1
├── last_sighted_at           TIMESTAMPTZ
├── last_sighted_conversation_id  UUID FK → conversations (nullable)
│
-- Detection metadata
├── detection_confidence      FLOAT           -- LLM confidence (0–1)
├── detection_model           TEXT            -- model that produced the detection
│
-- Formalization bridge (Layer 1→2)
├── candidate_formal_statement  TEXT          -- populated when status='ready'
├── formalization_offered_at    TIMESTAMPTZ
├── human_reviewed              BOOLEAN DEFAULT FALSE
├── human_review_note           TEXT
├── formalized_claim_id         UUID FK → claims (nullable)
├── formalized_node_id          UUID FK → nodes  (nullable)
│
-- Display
├── salience                  FLOAT           -- surfacing priority (0–1)
├── tags                      TEXT[]
│
├── created_at                TIMESTAMPTZ DEFAULT now()
└── updated_at                TIMESTAMPTZ DEFAULT now()

CONSTRAINTS:
  status IN ('active', 'accumulating', 'ready', 'formalized', 'abandoned')
  detection_confidence BETWEEN 0.0 AND 1.0
  salience BETWEEN 0.0 AND 1.0

INDEXES:
  (conversation_id, status)           -- surfacing active prayers per session
  (status, salience DESC)             -- priority queue for resume cards
  (last_sighted_conversation_id)      -- "what was alive in this session?"
  (formalized_claim_id)               -- reverse-lookup from claim to origin prayer
```

### 3. Schema: `intent_signal_sightings`

One row per (intent signal, conversation) it reappears in. Enables the query
"what intent signals were active in session X?" without JSONB containment searches.

```sql
intent_signal_sightings
├── id                        UUID PRIMARY KEY
├── intent_signal_id          UUID FK → intent_signals ON DELETE CASCADE
├── conversation_id           UUID FK → conversations
│
-- Evidence for this sighting
├── utterance_ids             UUID[]          -- utterances in this session that reference it
├── context_note              TEXT            -- how it was re-raised (verbatim or summary)
├── sighting_confidence       FLOAT           -- LLM confidence this is the same signal
│
├── sighted_at                TIMESTAMPTZ DEFAULT now()

INDEXES:
  (intent_signal_id)          -- all sightings for a given signal
  (conversation_id)           -- all signals active in a given session
  UNIQUE (intent_signal_id, conversation_id)  -- one sighting per signal per session
```

### 4. LLM Detection Contract

The detection pass runs after the accumulation gate, over the completed segment.
It is a separate LLM call with its own contract (Contract C), independent of
the thread graph delta (Contract B defined in ADR-010).

#### Contract C: Intent Signal Detection

**Input context provided to model:**
- Completed segment text (utterances with speaker labels)
- Active threads at time of segment (names only, for disambiguation)
- Previously detected intent signals for this conversation (names/summaries, to
  avoid duplicates)

**Required JSON output — array of objects:**

```json
[
  {
    "raw_text": "string — verbatim quote from transcript",
    "context_summary": "string — 1–2 sentence description of surrounding discussion",
    "speaker_id": "string — speaker label as it appears in transcript",
    "source_utterance_refs": ["string — utterance identifiers or sequence numbers"],
    "detection_confidence": 0.0,
    "is_new": true,
    "existing_signal_match": null
  }
]
```

**Field rules:**
- `raw_text` — must be a direct quote, not a paraphrase. If no verbatim quote is
  extractable, omit the item.
- `context_summary` — what was being discussed around this gesture. Preserves
  specificity; must not over-abstract.
- `detection_confidence` — 0.0–1.0. Threshold for persistence: ≥ 0.6.
- `is_new` — false if this appears to be a re-surfacing of a previously detected
  signal; in that case populate `existing_signal_match` with the signal's id.
- Empty array is valid (no prayers detected in this segment).

**Validation rules (same pattern as ADR-010 Contract B):**
- Unknown keys ignored.
- Missing required fields drop that item, not the batch.
- Parse/contract failures recorded in `analysis_events` with stage, model, error,
  and attempt index. Never block transcript persistence.
- Items below confidence threshold (< 0.6) are discarded, not persisted.

**Mapping to `intent_signals` columns:**

| Contract C field | DB column |
|---|---|
| `raw_text` | `raw_text` |
| `context_summary` | `context_window` |
| `speaker_id` | `speaker_id` |
| `source_utterance_refs` | `source_utterance_ids` (resolved to UUIDs) |
| `detection_confidence` | `detection_confidence` |
| model name from config | `detection_model` |
| `existing_signal_match` | triggers sighting creation on existing row |

### 5. Layer 1→2 Formalization Bridge

**Lifecycle state machine:**

```
detected
   │
   ▼
'active'  ──── reappears in another session ────► 'accumulating'
   │                                                     │
   │                                                     │
   └──────── human marks "ready" ◄──────────────────────┘
                     │
                     ▼
                  'ready'
                     │  system populates candidate_formal_statement
                     │  (LLM drafts; human reviews)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     'formalized'          'abandoned'
   (claim or node        (human explicitly
    created; FK set)       dropped it)
```

**Formalization trigger: manual only (v1)**

Status moves to `ready` only when a human explicitly marks it. The system never
auto-promotes. This upholds "offer, never direct" and avoids false positives
while the detection model is being calibrated.

Future v2 (once false-positive rate is measured): auto-promote to `ready` when
`sighting_count ≥ N` across `M` distinct sessions, surfaced as a suggestion
requiring one-click confirmation rather than silent promotion.

**Candidate formal statement generation:**

When a human marks a signal `ready`, the system:
1. Assembles: `raw_text` + `context_window` + all sighting `context_note` values
   (ordered by `sighted_at`).
2. Calls LLM with a formalization prompt: "Given this pre-formal intention and its
   accumulated context, draft a candidate formal statement (claim, question, or
   theorem stub) for human review."
3. Writes the result to `candidate_formal_statement` and sets
   `formalization_offered_at`.
4. Surfaces to the human for review. Human either:
   - Accepts → system creates a `Claim` or `Node`, sets `formalized_claim_id` /
     `formalized_node_id`, status → `'formalized'`.
   - Edits and accepts → same, with edited text.
   - Rejects → status returns to `'accumulating'`; `human_review_note` records why.
   - Abandons → status → `'abandoned'`.

**Surfacing at lulls:**

Intent signals with `status IN ('active', 'accumulating')` are candidates for
resume cards. Priority order: `salience DESC`, `last_sighted_at DESC`. Resume
card includes `raw_text`, `context_window`, sighting count, and suggested
re-entry phrasing (generated or templated).

---

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Force into `threads` (low salience) | No new table | Premature naming; loses pre-formal specificity |
| B | Force into `claims` | Reuses existing schema | Imposes factual/normative/worldview structure prematurely |
| C | JSONB `accumulated_context` on a single `intent_signals` table | Simpler schema | "What signals were active in session X?" is awkward JSONB query; no FK integrity per sighting |
| D | `intent_signals` + `intent_signal_sightings` join table (chosen) | Clean per-session queries; FK integrity; extensible per-sighting metadata | Two tables; JOIN required |

---

## Assumptions

1. Detection confidence threshold of 0.6 is a starting heuristic; calibrate against
   human-labelled sessions once data exists.
2. Local models (qwen, mistral) can satisfy Contract C reliably at ~200-token input
   segments; validate against real transcripts before shipping to live path.
3. The formalization LLM call is non-blocking and non-critical — it can fail without
   affecting transcript persistence or the primary graph path.

---

## Constraints

1. `intent_signals` rows are immutable after creation (fact-layer principle from
   ADR-010): `raw_text` and `context_window` must not be edited post-detection.
   Corrections are additive (new sighting with corrected note, or status update).
2. Detection must not block transcript persistence. Contract C failures are telemetry,
   not errors.
3. Must be backward-compatible: existing conversations have no `intent_signals` rows.
   That is the correct state — prayers not yet detected are simply not yet detected.

---

## Consequences

**Positive:**
- Prayers become a durable, queryable primitive anchored to the fact layer.
- The Layer 1→2 bridge has a concrete mechanism: accumulate → human marks ready →
  LLM drafts → human reviews → promote or reject.
- Resume cards can surface prayers with full specificity intact.
- Detection failures are visible in `analysis_events`; no silent loss.

**Negative:**
- New migration required (`intent_signals`, `intent_signal_sightings`, indexes).
- Contract C adds a second LLM call per segment to the live path; latency impact
  must be measured and gated if needed.
- Detection quality is unknown until calibrated against real sessions.

---

## Rollout Plan

1. Write and apply Alembic migration for `intent_signals` and `intent_signal_sightings`.
2. Implement Contract C validator and persistence helper (pattern mirrors
   `persist_import_graph` in `import_persistence.py`).
3. Wire Contract C call into live transcript path after Contract B (graph delta),
   behind a feature flag `INTENT_SIGNAL_DETECTION_ENABLED`.
4. Build minimal UI surface: intent signal tray on conversation view, resume card
   inclusion, manual "mark ready" action.
5. Measure: detection rate, confidence distribution, false-positive rate (human-labelled).
6. After calibration: define auto-promote thresholds for v2.

---

## Success Criteria

1. Intent signals are persisted for ≥ 80% of live sessions where detection is enabled.
2. Resume cards include at least one intent signal for conversations with ≥ 3 detected signals.
3. Formalization flow (mark ready → review → promote) works end-to-end in manual testing.
4. No silent failures: all Contract C errors appear in `analysis_events`.
5. False-positive rate < 20% as measured by human review of first 50 detected signals.

---

## Related

- `docs/VISION.md` — mission and four-layer architecture
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md` — two-layer schema,
  Contract A and B; amendment identifies this gap
- `docs/adr/ADR-008-local-stt-transcripts.md` — fact-layer immutability principle
- `lct_python_backend/models.py` — existing ORM models
- `lct_python_backend/services/import_persistence.py` — pattern for persistence helpers
