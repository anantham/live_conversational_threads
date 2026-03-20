# ADR-018: Edit History Contracts and Training Data Export

**Date:** 2026-03-19
**Status:** Proposed
**Group:** data + interaction + integration

---

## Issue

The edit history subsystem was scaffolded during the initial schema migration (v2 data model) with
a complete database schema, API endpoints, service layer, and frontend page. However, the subsystem
has never functioned end-to-end because several design decisions were left implicit:

1. **User attribution** is hardcoded to `"user"` with a TODO comment, blocking meaningful
   provenance tracking for training data.
2. **Feedback storage** has a dedicated `EditFeedback` table in the schema, but the service
   ignores it and overwrites a flat `user_comment` field instead.
3. **Export workflow** generates training data files but never marks edits as exported, so the
   `unexported_only` filter returns everything every time.
4. **Field naming** between frontend and backend is mismatched — the UI references `edit.exported`
   and `edit.timestamp` while the API returns `edit.exported_for_training` and `edit.created_at`,
   causing silent rendering failures.
5. **Edit types** — the schema constrains `edit_type` to
   `correction|addition|deletion|merge|split`, but only `correction` is ever produced.

These five gaps prevent the subsystem from delivering its core value: capturing human corrections
to LLM-generated conversation graphs as structured training data.

---

## Context

- The `EditsLog` and `EditFeedback` tables were created in the initial v2 schema migration
  (`732e0cd9a870`). Both tables are migrated and functional at the database level.
- `edit_history_api.py` exposes five endpoints: node update with edit logging, edit listing,
  statistics, training data export (JSONL/CSV/Markdown), and feedback annotation.
- `EditHistory.jsx` provides a UI with diff visualization, statistics cards, and export buttons,
  but field name mismatches prevent it from rendering correctly.
- `TrainingDataExporter` formats edits as OpenAI fine-tuning JSONL, CSV, or human-readable
  Markdown. The JSONL format wraps each edit as a system/user/assistant message triple.
- LCT is a single-user, local-first application. There is no auth system and building one is
  out of scope. However, the distinction between human edits and machine-suggested edits is
  valuable for training data quality.
- ADR-017 establishes that the graph will be progressively refined, which means more edit types
  (merge, split) will naturally emerge as the graph synthesis pipeline matures.

---

## Decision

### 1. Role-based actor identity instead of user authentication

Replace the hardcoded `user_id = "user"` with a role-based `actor_type` field that captures
*what kind of actor* made the edit rather than *which person*:

- `human` — a person made this correction through the UI
- `llm_suggestion` — an LLM proposed this edit (for future auto-correction flows)
- `import_correction` — an automated correction during transcript import
- `bulk_operation` — a batch or programmatic edit

The existing `user_id` column remains for forward compatibility but defaults to `"default"` and
is not wired to an auth system.

**Export integration:** `actor_type` must appear in all three export formats:

- **JSONL**: Add `actor_type` to the `metadata` object in each training example. The export
  endpoint must accept an optional `actor_type_filter` query parameter (default: `"human"`)
  so callers can export only human corrections for fine-tuning by default.
- **CSV**: Add `actor_type` as a column after `user_id`.
- **Markdown**: Include `actor_type` in the edit header line.

The current exporter (`training_data_export.py:141`) emits `user_id` in metadata. After this
ADR, it emits both `user_id` and `actor_type`, and the default filter excludes non-human edits
from training exports unless explicitly requested.

**Rationale:** The training data use case needs to distinguish human corrections from machine
suggestions — that's the signal that makes fine-tuning data valuable. A full auth system solves
a problem LCT doesn't have (multi-user identity) at substantial infrastructure cost. The
export filter is where this signal becomes actionable — without it, `actor_type` is collected
but never used, which defeats its purpose.

### 2. Separate edit rationale from later annotation; remove EditFeedback table

The `user_comment` field has an existing semantic: the author's rationale at edit-creation
time ("why I made this change"). This is distinct from later annotation ("looking back, was
this edit good?"). The ADR preserves this distinction with two fields:

- `user_comment` (existing) — set at edit-creation time via `log_edit()` / `log_node_edit()`.
  Immutable after creation. Represents contemporaneous intent.
- `annotations` (new TEXT column) — populated by `POST /api/edits/{edit_id}/feedback`.
  Append-only with timestamp separators. Represents post-hoc review notes.

```
[2026-03-19T14:30:00Z] First annotation
[2026-03-19T15:45:00Z] Second annotation after reviewing training output
```

Drop the `EditFeedback` table in a follow-up migration. The `annotations` column replaces it.

**Rationale:** The EditFeedback table is unused, the feature is speculative, and iterative
structured annotation is not part of the current workflow. But collapsing rationale and
feedback into one field erases a meaningful distinction: "why I edited" is training-data
signal, while "was this edit good?" is quality-control signal. Two flat text columns preserve
both semantics without requiring a join table. If structured feedback becomes necessary later,
a table can be re-added — adding tables is easier than removing them.

### 3. Mark-on-export with a reset escape hatch

The export endpoint marks all included edits as exported and assigns a `training_dataset_id`.
Subsequent calls with `unexported_only=true` return only edits created after the last export.

Add a recovery endpoint:

```
POST /api/conversations/{conversation_id}/edits/reset-export
```

This clears `exported_for_training` and `training_dataset_id` for all edits in the conversation,
allowing re-export after download failures or workflow mistakes.

**Rationale:** A simple queue model (export = consume) matches the mental model of "pull new
training data." The failure mode (download fails, edits marked as consumed) is rare and
recoverable via the reset endpoint. A two-step finalize workflow adds ceremony without
proportional benefit for a single-user tool.

### 4. Pydantic response models with complete public contract

Add response models that define the exact shape the frontend consumes. The response model is
the **single source of truth** for the API contract — frontend code references these field
names, not database column names.

#### `EditResponse` — single edit object

| Database column | API field | Type | Notes |
|-----------------|-----------|------|-------|
| `id` | `id` | `str` | UUID as string |
| `target_type` | `target_type` | `str` | `node\|relationship\|cluster\|...` |
| `target_id` | `target_id` | `str` | UUID as string |
| `field_name` | `field_name` | `str` | Which field was edited |
| `old_value` | `old_value` | `str\|null` | Previous value |
| `new_value` | `new_value` | `str\|null` | New value |
| `edit_type` | `edit_type` | `str` | `correction\|addition\|deletion\|merge\|split` |
| `user_id` | `user_id` | `str` | Actor identifier |
| `actor_type` | `actor_type` | `str` | `human\|llm_suggestion\|import_correction\|bulk_operation` |
| `user_comment` | `user_comment` | `str\|null` | Contemporaneous rationale (set at creation) |
| `annotations` | `annotations` | `str\|null` | Post-hoc review notes (appended via feedback endpoint) |
| `user_confidence` | `user_confidence` | `float` | 0.0–1.0 |
| `exported_for_training` | `exported` | `bool` | Alias: shorter name |
| `training_dataset_id` | `training_dataset_id` | `str\|null` | Which export batch |
| `created_at` | `timestamp` | `str` | Alias: ISO 8601 string |
| _(computed)_ | `feedback` | `list[{text, timestamp}]` | Parsed from `annotations` column; empty list if null |

The `feedback` field is computed by parsing the `annotations` text into structured objects,
giving the frontend the `edit.feedback.map((fb) => ...)` array it expects without requiring
a join table.

#### `EditListResponse` — list endpoint wrapper

```
{
  conversation_id: str,
  edits: EditResponse[],
  count: int
}
```

#### `EditStatisticsResponse` — statistics endpoint

| Backend field | API field | Type | Notes |
|---------------|-----------|------|-------|
| `total_edits` | `total_edits` | `int` | Total edit count |
| `edits_by_target_type` | `by_target_type` | `dict` | Alias: matches frontend `statistics.by_target_type` |
| `edits_by_edit_type` | `by_edit_type` | `dict` | Alias |
| `exported_count` | `exported_count` | `int` | |
| `unexported_count` | `unexported_count` | `int` | |
| `export_percentage` | `export_percentage` | `float` | |
| _(computed)_ | `feedback_count` | `int` | Count of edits where `annotations IS NOT NULL` |

Note: `feedback_count` counts edits with post-hoc annotations, not edits with
contemporaneous `user_comment`. These are distinct: `user_comment` is the "why I made
this change" note set at creation time; `annotations` is later review feedback.

**Rationale:** This is consistent with how `BookmarksListResponse`, `GraphResponse`, and other
API endpoints already handle serialization. It decouples the database schema from the API
contract, allowing either to evolve independently. Specifying the complete response shape
(not just the renamed fields) ensures an implementer can follow this ADR and produce a
working page without cross-referencing frontend source.

### 5. Keep edit type extensibility; document each type's intent

Retain the full constraint (`correction|addition|deletion|merge|split`). Document each type:

| Type | Meaning | When produced | Example |
|------|---------|---------------|---------|
| `correction` | Human fixes an LLM-generated value | Node summary edit in UI | Changing a node title from "Discussion" to "Debate on epistemic humility" |
| `addition` | Human adds a value that was missing | Adding a keyword to a node | Adding "epistemology" as a keyword |
| `deletion` | Human removes an incorrect value | Removing a misattributed utterance | Deleting a speaker attribution |
| `merge` | Human combines two entities | Merging duplicate nodes | Collapsing two nodes about the same topic |
| `split` | Human separates a conflated entity | Breaking a node into two | Splitting a node that covered two distinct arguments |

Only `correction` is currently produced by `log_node_edit()`. Other types will be wired as
graph editing capabilities mature (per ADR-017's progressive refinement model). The frontend
should handle unknown types gracefully.

**Rationale:** These types map to real operations on the roadmap. Removing them now to add them
back later is churn. The schema cost of unused enum values is zero. The documentation cost of
explaining them is small and prevents future confusion.

---

## Consequences

### Positive

- The edit history page will actually render correctly after the response model is added.
- Training data exports will have meaningful provenance (`actor_type`) with a default filter
  that exports only human corrections, enabling higher-quality fine-tuning datasets.
- The export workflow becomes functional — `unexported_only` will work as intended, with a
  reset mechanism for error recovery.
- Schema simplification: one fewer table (`EditFeedback`) to maintain and migrate.

### Tradeoffs

- Role-based identity (`actor_type`) cannot distinguish between two different humans using
  the same LCT instance. This is acceptable for a single-user tool but would need revisiting
  if LCT becomes collaborative.
- Removing `EditFeedback` loses the ability to have structured, independently queryable
  annotations per edit. The append-to-text-field approach (parsed into `[{text, timestamp}]`
  at read time) preserves history but not efficient filtering by annotation content.
- Mark-on-export is non-idempotent — a failed download marks edits as consumed. The reset
  endpoint mitigates this but requires the user to notice and act.
- Adding a Pydantic response model adds a maintenance surface (DB schema changes must be
  reflected in the model). This is standard practice in the codebase and the cost is low.

---

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **User attribution** | | | |
| A | Single-user, remove TODO | Honest, zero effort | Loses human-vs-machine signal for training data |
| B | Auth token extraction | Proper multi-user | Massive scope creep, no auth system exists |
| C | Role-based actor identity (chosen) | Captures useful signal without auth infra | Can't distinguish individual humans |
| **Feedback storage** | | | |
| A | Use EditFeedback table as designed | Supports iterative structured annotation | Over-engineered for current usage, complex queries |
| B | Remove table, collapse into user_comment | Simplest, one field | Conflates rationale with annotation, overcounts feedback_count |
| C | Hybrid (comment + feedback table) | Clear separation, structured queries | Over-engineered join table for rare operation |
| D | Remove table, separate annotations column (chosen) | Preserves rationale/annotation distinction, no join | Two text columns, parsed at read time |
| **Export workflow** | | | |
| A | Mark on export + reset endpoint (chosen) | Simple queue model with recovery | Non-idempotent export call |
| B | Separate finalize step | Idempotent exports | Two-step ceremony, easy to forget |
| C | Dataset-ID-based tracking | Full traceability | Enterprise-grade complexity for personal tool |
| **Field naming** | | | |
| A | Backend renames to match frontend | Frontend works immediately | Migration or dual naming |
| B | Frontend renames to match backend | No backend changes | Verbose JSX, wrong dependency direction |
| C | Pydantic response model (chosen) | Consistent with codebase, decouples layers | Small maintenance surface |

---

## Assumptions

1. LCT remains primarily single-user. Multi-user collaboration is not on the near-term roadmap.
2. The primary consumer of training data exports is OpenAI fine-tuning (JSONL format).
3. Edit frequency is low enough that append-to-text-field feedback does not create performance
   or readability issues.
4. Graph editing operations (merge, split) will emerge from ADR-017's progressive refinement
   pipeline within the next few development cycles.

---

## Constraints

1. No new database tables. This ADR removes one table and adds two columns (`actor_type`,
   `annotations`).
2. The migration must handle existing rows (backfill `actor_type = 'human'` for all existing edits).
3. The `/api/nodes/{node_id}` PUT endpoint contract is preserved — the request shape does not change.
4. Frontend changes are limited to consuming the new response model fields; no new pages or routes.

---

## Implementation Sequence

1. **Migration**: Add `actor_type` column (TEXT, default `'human'`) and `annotations` column
   (TEXT, nullable) to `EditsLog`. Backfill existing rows with `actor_type = 'human'`.
2. **Migration**: Drop `EditFeedback` table.
3. **Response models**: Create `EditResponse`, `EditListResponse`, and
   `EditStatisticsResponse` Pydantic models matching the complete public contract above.
   `EditResponse.feedback` is a computed field that parses `annotations` into
   `[{text, timestamp}]` objects.
4. **Wire response models**: Update all `edit_history_api.py` endpoints to return response
   models instead of inline dicts.
5. **Feedback endpoint**: Change `add_feedback()` to append to `annotations` column (not
   `user_comment`) with timestamp prefix. `user_comment` remains immutable after creation.
6. **Export endpoint**: Wire `mark_as_exported()` after successful export. Add
   `actor_type_filter` query parameter (default `"human"`). Add `actor_type` to JSONL
   metadata, CSV columns, and Markdown headers.
7. **Reset endpoint**: Add `POST /api/conversations/{id}/edits/reset-export`.
8. **Frontend**: Update `EditHistory.jsx` field references to match response model. Key
   changes: `statistics.edits_by_target_type` → `statistics.by_target_type`,
   `edit.exported_for_training` → `edit.exported`, `edit.created_at` → `edit.timestamp`.
   `edit.user_comment` remains unchanged. `edit.feedback` now works (populated from
   `annotations` parsing).
9. **Tests**: Add tests for each endpoint against the new contracts. Include: actor_type
   filtering in exports, annotations append semantics, mark-on-export workflow,
   reset-export idempotency, response model field validation.

---

## Related

- `lct_python_backend/edit_history_api.py` — API endpoints
- `lct_python_backend/services/edit_logger.py` — Core edit logging service
- `lct_python_backend/services/training_data_export.py` — Export formatters
- `lct_python_backend/models/interaction.py` — EditsLog and EditFeedback models
- `lct_app/src/pages/EditHistory.jsx` — Frontend page
- `lct_app/src/services/editHistoryApi.js` — Frontend API client
- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md` — Graph progressive refinement (informs edit type roadmap)
- `docs/adr/ADR-013-intent-signals-prayers-schema.md` — Intent signals may formalize into claims that are then human-edited
