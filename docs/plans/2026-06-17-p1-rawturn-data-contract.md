# P1 — The `RawTurn[]` data contract (IndrasNet → LCT, one conversation)

**Status:** design proposal (2026-06-17) · pending codex adversarial review, then build.
**Builds on:** `docs/plans/2026-06-08-lct-indrasnet-pipeline.md` (P0 shipped + now tested, PR #59).
**Scope:** the versioned ingest contract that replaces the lossy markdown `/from-text`
path with structured, provenance-bearing turns — plus the privacy policy for what the
LCT mirror stores. Spans **two repos**; this doc fixes the contract so neither side
guesses.

---

## 1. Why a new contract (what's wrong today)

Today IndrasNet hands a conversation to LCT as **markdown text**:

- `POST /api/import/from-text` accepts only `ImportFromTextRequest{ text, conversation_name?, owner_id? }` (`import_api.py:330-357`) → `parse_validate_and_persist` (`import_orchestrator.py:71`) → `persist_transcript` (`graph_persistence.py:250`).
- `persist_transcript` creates `Utterance` rows (`graph_persistence.py:280-290`) setting `text, speaker_id, sequence_number, timestamp_start/end, platform_metadata` — but **not** `source_identifier` (the P0 provenance anchor) and **not** `Conversation.indrasnet_group_id`.

Consequences:
1. **Provenance anchor is inert.** `Utterance.source_identifier` exists (P0 migration) but is all-NULL for every import — so `_compute_source_ref`'s `source_identifiers` are empty and cross-repo re-pull can't key on a stable per-turn id.
2. **No real identity.** Markdown can't carry per-turn `contact_id`, precise timestamps, `redaction_applied`, or a `group_id` → LCT can't dedup re-imports or honor per-participant privacy.
3. **Lossy.** Re-parsing markdown is a second, fallible parse of data IndrasNet already has structured.

## 2. The contract (`contract_version: "1"`)

Both access modes (§3) return the **same shape**. Keyed by IndrasNet `group_id`.

```jsonc
{
  "contract_version": "1",
  "group_id": "string",            // IndrasNet stable conversation key → Conversation.indrasnet_group_id
  "conversation_id": "uuid|null",   // LCT id IF this group_id was imported before (re-ingest); else null
  "conversation_name": "string",
  "source_type": "string",          // 'google_meet' | 'slack' | ...  (mirrors Conversation.source_type)
  "owner_id": "string",
  "privacy": {
    "external_llm_ok": false,       // most-restrictive across participants; gates frontier calls
    "local_llm_ok": true,
    "redaction_applied": true,      // TRUE = `text` below is already pseudonymized
    "redaction_map_id": "string|null" // which REDACTION_MAP produced it (for restore-on-display)
  },
  "turns": [
    {
      "seq": 0,                     // 0-based, dense, monotonic → Utterance.sequence_number
      "source_identifier": "meet:GROUP:0",  // stable per-turn id → Utterance.source_identifier (NEVER null)
      "speaker_id": "string",       // diarized label
      "contact_id": "string|null",  // IndrasNet contact identity (null if unresolved)
      "text": "string",             // verbatim at the privacy tier (redacted iff redaction_applied)
      "ts_start": 0.0,              // seconds, nullable
      "ts_end": 0.0
    }
  ]
}
```

**Invariants (contract-enforced, return 422 on violation):**
- `(group_id, seq)` is unique within a payload; `source_identifier` unique within a payload and **non-null**.
- `seq` dense from 0 (no gaps) — so coverage math and ordering are unambiguous.
- `text` is **never truncated/summarized** (the "no arbitrary compression" constraint) — it may be *redacted*, which is not compression.
- `redaction_applied=false` is **rejected** unless the request also carries an explicit `owner_local_raw=true` (see §4).

`RawTurn` → one `Utterance`: `seq→sequence_number`, `source_identifier→source_identifier`, `speaker_id→speaker_id`, `text→text`, `ts_*→timestamp_*`, `contact_id→platform_metadata.contact_id`. `(seq, source_identifier)` is the durable provenance key carried into `node.source_ref` (already wired in P0).

## 3. Two access modes

- **PUSH (LCT owns the endpoint — THIS PR's LCT slice).** New `POST /api/import/turns` accepting the payload above → creates/updates the conversation + `Utterance` rows **with `source_identifier`** → returns `conversation_id`. Replaces the markdown round-trip. `/from-text` stays for human paste (unchanged).
- **PULL (IndrasNet owns the endpoint — cross-repo follow-up).** `GET /api/lct/conversations/{group_id}/turns` on IndrasNet returns the same shape (gates + redaction run server-side; LCT never reads IndrasNet's DB). For re-extraction/backfill. NOT `/api/retrieval/search` (wrong, cross-source rerank semantics).

## 4. Redaction-at-mirror policy (the decision §123 flagged)

**Principle:** raw source-of-truth lives in **IndrasNet**; the **LCT mirror is REDACTED by default**. "No arbitrary compression" forbids lossy *summarization* of whatever tier LCT holds — it does **not** require LCT to hold unredacted text.

**Therefore:**
1. **IndrasNet redacts before PUSH/PULL** (its `share_pipeline` + canonical `REDACTION_MAP`), governed by the three-gate check. The contract's `redaction_applied` MUST be `true` by default; `text` is pseudonymized.
2. **LCT stores what it receives, verbatim** (redacted text + the `privacy` block on the `Conversation`). It does NOT re-redact or compress.
3. **Restore-on-display only.** Real names re-appear only in the LCT-local viewer, via a local restore map keyed by `redaction_map_id` (owner-local, never serialized into a shareable `.threads`).
4. **Owner-local raw escape hatch.** A single-user local deployment may set `LCT_MIRROR_RAW=1` (owner-only, loopback) to accept `redaction_applied=false` and store raw — for the local-first owner-owns-their-data case. Off by default; refused in any shared/public deployment (ADR-034 tier).
5. **Redaction-at-frontier is a SEPARATE guarantee.** The `LCT_LOCAL_ONLY` egress chokepoint (`egress_chokepoint.py:103`, wraps `httpx.send`) blocks non-local **URLs** and is a **no-op when `LCT_LOCAL_ONLY=0`** (`egress_guard.py:118`); it does not inspect payloads.
6. **What LCT enforces vs. trusts (codex #1).** LCT **cannot verify** that `redaction_applied=true` is honest — a boolean can't prove the text is pseudonymized, and subprocess/CLI engines open their own sockets outside the chokepoint. LCT *trusts* the upstream flag. The actual guarantee — a content-bound redaction **stamp** + outbound **leak-verify** — is **ADR-038 / Task #3** and is a hard **precondition** for relying on the PUSH path; it is NOT provided by this contract. The only redaction rule this contract itself enforces is the `owner_local_raw` gate (refuse raw unless explicitly opted in). So §4 is a *policy + precondition*, not an LCT-enforced mechanism.

This makes the mirror safe-by-default *given an honest upstream* (a leaked/shared LCT holds only pseudonyms) while the owner keeps a local restore path.

## 5. Dedup & re-ingest semantics

- New **composite partial unique index** `UNIQUE(owner_id, indrasnet_group_id) WHERE indrasnet_group_id IS NOT NULL AND deleted_at IS NULL` (codex #2 — a bare `UNIQUE(indrasnet_group_id)` collides across owners; `models/core.py:30` is currently bare `Column(Text)`, no index). **Soft-delete:** a soft-deleted conversation must NOT reserve its `group_id` (the `deleted_at IS NULL` predicate above), so re-import after delete is allowed.
- On PUSH: if `conversation_id` is given OR a row with this `(owner_id, group_id)` exists → **replace** semantics (delete the conversation's `Utterance`/graph rows, re-ingest turns) inside one transaction, preserving the same `conversation_id` (stable shareable URL). Else create new.
- **Replace, not append/merge** for v1: IndrasNet is the source of truth and re-sends the whole conversation; merge/diff is deferred (a v2 concern). Document this so callers don't expect incremental appends.

## 6. LCT-side build (what the PR implements)

1. **Migration:** (a) the composite partial unique index from §5; (b) **DB-level turn dedup** (codex #5 — `idx_utterances_conversation` is non-unique, Pydantic alone can't prevent dup rows): `UNIQUE(conversation_id, sequence_number) WHERE source_identifier IS NOT NULL` and `UNIQUE(conversation_id, source_identifier) WHERE source_identifier IS NOT NULL` (**both scoped to RawTurn rows** — dev-DB verification found 7 existing conversations with duplicate `seq=1` from live-STT/segment-resume, so a global seq index is wrong; RawTurn ingest guarantees dense unique seqs and a conversation's rows are all-RawTurn or all-legacy). Column stays nullable (legacy/non-IndrasNet imports), uniqueness covers the populated case. (c) **Migration safety (codex re-review #6):** these indexes will **fail to create** if duplicate rows already exist (the current schema permitted them). The migration MUST run **preflight** queries first — duplicate `(conversation_id, sequence_number)`, duplicate non-null `(conversation_id, source_identifier)`, and duplicate active `(owner_id, indrasnet_group_id)` where `deleted_at IS NULL` — and on any hit **fail fast with a diagnostic** listing the offending ids (do **NOT** auto-delete provenance rows; the owner remediates). Implement each as a partial **unique index** via `op.create_index(..., unique=True, postgresql_where=sa.text(...))` — Postgres has no partial UNIQUE *constraint*, so a table constraint won't work.
2. **Pydantic models:** `RawTurnsPayloadV1` + `RawTurnV1` with the §2 validators (validation is defense-in-depth, NOT the integrity guarantee — that's the DB constraints in 1b).
3. **`persist_turns()`** (new, beside `persist_transcript` in `graph_persistence.py`): upsert conversation by `(owner_id, group_id)`; set `indrasnet_group_id` + the privacy block on **`source_metadata`** (NB the column is `source_metadata`, not `metadata` — `persist_transcript:274` passes `metadata=`, a latent mismatch / codex nit; don't copy it). Create `Utterance` rows **explicitly setting `source_identifier`** — do **NOT** reuse the `persist_graph` utterance insert (`graph_persistence.py:950`), which omits `source_identifier` and would silently drop provenance (codex #4). `contact_id` → `platform_metadata.contact_id`.
4. **Endpoint:** `POST /api/import/turns` → `persist_turns` → `{ conversation_id, utterance_count }`. Inbound, so the egress chokepoint is irrelevant; the only privacy gate enforced here is `owner_local_raw`.
5. **`indrasnet_turns_adapter`** (`lct_pipeline/` seed): pure mapper IndrasNet `items` → `RawTurnsPayloadV1`, so the cross-repo side has a reference shape. (Lives in LCT as the contract's canonical serializer; IndrasNet imports or mirrors it.)
6. **Coverage is NOT auto-fixed by this PR (codex #3).** `build_coverage_summary` counts `source_ref.utterance_ids` (`conversation_reader.py:489`), not `source_identifiers`; `_compute_source_ref` only enriches nodes that ALREADY carry `utterance_ids`. So populating `Utterance.source_identifier` makes the provenance ref *richer* but does not by itself make coverage meaningful — that additionally requires the **graph extraction/persistence path to link each node to its `utterance_ids`** (or persist a valid `Node.source_ref`). Whether current clustering populates `node.utterance_ids` must be audited; if not, that node↔utterance linking is a **distinct P1.5 item**, tracked separately. This PR's provenance win is the lossless per-turn anchor, not coverage.

## 7. Cross-repo follow-up (NOT this PR)

- IndrasNet `GET /api/lct/conversations/{group_id}/turns` (PULL).
- IndrasNet `lct_client` switched from `import_transcript`(markdown) → `POST /api/import/turns`(structured), sending **redacted** turns.
- **🔴 Privacy bug precondition (plan §126):** IndrasNet `also_share_to_lct` currently ships the **unredacted** stitched source (`privacy.py:865/:940`); `produce_share_artifacts` builds the redacted `artifact_md` but doesn't return it (`share_pipeline.py:882/:1040`). The PUSH path must not be relied on for privacy-sensitive conversations until this is fixed/disabled.

## 8. Open decisions (recommendation in **bold**)

1. New endpoint vs extend `/from-text`? → **new `/api/import/turns`** (keep `/from-text` as the human-paste markdown path).
2. Re-ingest semantics? → **replace** (whole-conversation, stable `conversation_id`); merge deferred to v2.
3. Mirror default? → **redacted-by-default**, `LCT_MIRROR_RAW=1` owner-local escape hatch.
4. `contact_id` storage? → **`platform_metadata.contact_id`** for v1 (no new column); promote to a typed FK only when LCT consumes contact identity directly (P3).
5. Versioning? → **`contract_version` string in the payload**; endpoint rejects unknown majors; adapters keyed by version.
6. Where does the adapter live? → **LCT** (canonical serializer), IndrasNet mirrors/imports it.

## 9. Test plan

- Contract validation: missing/duplicate `source_identifier`, gappy `seq`, `redaction_applied=false` without `owner_local_raw` → 422.
- `persist_turns`: utterances created **with non-null `source_identifier`** on every row; second PUSH of same `(owner_id, group_id)` replaces (same `conversation_id`, no dup rows); `indrasnet_group_id` set; privacy block on `source_metadata`.
- DB constraints (codex #5, NOT just Pydantic): duplicate `(conversation_id, sequence_number)` and duplicate `(conversation_id, source_identifier)` rejected at the DB layer; the composite dedup index rejects a same-owner duplicate `group_id` but **allows** a different owner's same `group_id` and a re-import after soft-delete.
- Provenance anchor: after `persist_turns`, the conversation's source-id map carries real `source_identifier`s. (Coverage-meaningfulness is asserted only once node↔utterance linking lands — §6.6, separate item.)
- Redaction: `redaction_applied=false` refused unless `LCT_MIRROR_RAW=1`.

## 10. Rollout

P1a (this PR, LCT-only): migration (composite dedup + turn-uniqueness) + contract + `persist_turns` (sets `source_identifier`) + `/api/import/turns` + tests + adapter seed.
P1.5 (separate): node↔`utterance_ids` linking in the extraction/persist path so coverage is real (codex #3).
P1b (cross-repo, after §7 privacy fix): IndrasNet PULL endpoint + `lct_client` cutover + leak-verify on the handoff.
Then P2 (`lct_pipeline/` package) per the parent plan.

## 11. Review (codex adversarial, 2026-06-17) — verdict NEEDS-WORK → resolved

Independent read-only `codex exec` review (the ADR-038 F1–F5 pattern; full log not committed). Verdict **NEEDS-WORK**: "direction sound, but the doc overclaimed enforceability and provenance coverage." All 5 blocking findings are folded in above:
1. **Redaction not LCT-enforceable** → §4.6: reframed as an upstream stamp + leak-verify *precondition* (ADR-038), not an LCT guarantee; LCT enforces only `owner_local_raw`.
2. **Dedup index must be composite** → §5 / §6.1a: `UNIQUE(owner_id, indrasnet_group_id) WHERE … AND deleted_at IS NULL`.
3. **"Coverage becomes meaningful" was false** → §6.6 + P1.5: `source_identifier` enriches provenance, but coverage needs node↔`utterance_ids` linking (separate item).
4. **`persist_graph:950` drops `source_identifier`** → §6.3: `persist_turns` sets it explicitly, does not reuse that insert.
5. **Invariants not DB-enforced** → §6.1b: `UNIQUE(conversation_id, sequence_number)` + `UNIQUE(conversation_id, source_identifier) WHERE NOT NULL`.

Nits: `persist_transcript:274` passes `metadata=` vs the `source_metadata` column (latent mismatch — don't copy); `serialize_utterances` + the JSON export (`conversations_api.py:524/538`) omit the P0 fields (`source_ref`/`source_identifier`/`indrasnet_group_id`) — add when surfacing; IndrasNet §7 claims are unverifiable from this repo → hard external precondition.

**Re-review (codex, 2026-06-17, round 2):** all 5 findings above verified **RESOLVED** against doc-line + code. One **new blocking** finding — **migration safety** (the new unique indexes fail on a live DB with pre-existing duplicates) — folded into §6.1c (preflight audit + fail-fast + partial unique *index* not constraint). **Round 3: GO.**

**Implementation review (codex, 2026-06-17):** the built code (`raw_turn_contract.py`, `persist_turns`, `/api/import/turns`, the migration) was then codex-reviewed too. Round 1 → **NEEDS-WORK** with 4 runtime bugs the unit tests couldn't catch: (1) explicit `conversation_id` could destructively replace the wrong conversation; (2) the privacy gate was fail-open (no `extra=forbid`, `redaction_applied` defaulted); (3) the replace path FK-violated on `simulacra/bias/frame` (node FK without `CASCADE`); (4) bad timestamps surfaced as 500 not 422. All fixed → round 2 → **GO** (PR #59).

**Postgres runtime verification (dev DB, 2026-06-17) — gate CLOSED.** Ran the migration + `persist_turns` + an async integration test against real Postgres, then downgraded and cleaned up. Results: migration upgrade+downgrade work; the 3 partial unique indexes are created; `persist_turns` round-trips + replaces correctly (real FK cascade, JSONB `source_metadata`). The **preflight earned its keep** — it caught 7 existing conversations with duplicate `(conversation_id, seq=1)`, which forced the seq-uniqueness index to be scoped to RawTurn rows (§6.1b). Integration test: `tests/integration/test_persist_turns_pg.py` (skipif no `DATABASE_URL`).

**P1a is complete + verified.** Remaining downstream: P1.5 (node↔utterance linking for real coverage), P1b (IndrasNet PULL + the 🔴 unredacted-source bug), P2 (`lct_pipeline/` package).
