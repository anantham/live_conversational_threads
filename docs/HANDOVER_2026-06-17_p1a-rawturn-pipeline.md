# Handover: 2026-06-17 (P1a RawTurn ingest + privacy-logging + multi-PR session)

## Session Summary
Long `/impeccable`-rooted session that shipped four PRs to `main` and built the
LCT×IndrasNet pipeline's **P1a structured-turns ingest** end-to-end — designed,
codex-reviewed across 5 rounds (design ×3, implementation ×2), implemented, and
**verified against the real dev Postgres**. The verification mattered: each review
layer caught what the prior couldn't (codex found 4 runtime bugs the unit tests
missed; the dev-DB run found a legacy-data shape problem codex couldn't see). All
my work is merged + my worktrees cleaned up. The parallel session is active on
`feat/synthetic-eval-harness` (+ a `lct-trackb-fix` worktree) — untouched.

## PRs This Session (all merged to `main`)
- **#56** `fix/logging-privacy` — diagnostic-logging privacy remediation: unified
  `makeDebug(ns)` (default OFF), `readErrorMessage` (caps server bodies, drops the
  FastAPI 422 `input` key-leak), backend content logs gated behind
  `TRACE_API_CALLS` (default flipped to False), `LOG_LEVEL` fix, vite `drop` of
  console in prod. (memory: [[lct-diagnostic-logging-privacy-helpers]])
- **#57** `feat/attendee-gmeet-live-graph` — the parallel session's stack (P0
  pipeline, attendee meeting-bot, browse contact-scoping) — merged at user request.
- **#58** `chore/quick-wins-issues-audit` — 1-line ZoomControls `useEffect`
  import-from-`prop-types` fix (the other two "quick wins" were already done on
  main). Flagged the dead `DualView`/`ZoomControls` subsystem as a deletion
  candidate.
- **#59** `feat/pipeline-p1-turns-contract` — **P0 provenance tests + the P1
  RawTurn data-contract design + the P1a implementation**. The main deliverable.

## Pending Threads

### Continue Immediately (Task 2 — pipeline P1+)
1. **P1.5 — node↔utterance linking for real coverage.** Populating
   `Utterance.source_identifier` (P1a) does NOT make `build_coverage_summary`
   meaningful — coverage counts `node.source_ref.utterance_ids`. The
   extraction/clustering path must link nodes to their utterance ids (or persist a
   valid `Node.source_ref`). Investigate where `node.utterance_ids` is set today
   (`conversation_reader.py` / clustering). LCT-side, no cross-repo dep.
2. **P2 — `lct_pipeline/` package.** Productize the `.tmp_*` scripts into an
   idempotent package + CI lint rejecting new `.tmp_`.

### Blocked / Cross-repo
1. **P1b — IndrasNet PULL/PUSH side (TemporalCoordination repo).** Now **open PR
   `TemporalCoordination#17`** (`feat/lct-rawturn-pull-push`): `GET
   /api/lct/conversations/{group_id}/turns` PULL endpoint + `LCTClient.import_turns()`
   posting the structured `RawTurnsPayloadV1` to LCT `POST /api/import/turns`
   (replacing markdown `import_from_text`).
   **CORRECTION (audited 2026-06-20): the 🔴 "unredacted-source" privacy bug is
   CLOSED — it was never a live leak in current code.** It was a real P0
   (`text=content`) fixed 2026-06-14 (`c8e467f`, ancestor of HEAD): the share path
   ships only a doc-LINK, and `produce_share_artifacts` DOES return the redacted
   `artifact_md` (`share_pipeline.py:1068`) while the LCT-feeding caller refuses
   unless `verification_clean` then sends the redacted body (`privacy.py:948-954`);
   pinned by `test_sharing_pipeline.py:284-291`. Re-confirmed via a 3-lens adversarial
   workflow (CLOSED, 0.95). This line was already stale when first written (the fix
   pre-dated it by 3 days). **Remaining for P1b:** wire `_execute_share_via_lct` →
   `import_turns`. The GENUINE residual privacy concern is *separate* — the LCT
   import→extract path does no redaction / no `external_llm_ok` check; only the
   `LCT_LOCAL_ONLY` chokepoint guards it (see ADR-038, "Deferred / Flagged" #2).
2. **#10 Dialectic layout wiring** — `layoutDialectic()` landed (commit e0739e3,
   24 tests); UI wiring HELD on the **Vatsal viz-direction call**.
3. **#12 Vocab→WhisperX re-transcription** — needs the user's compute decision +
   the `.tmp_meetings_all/` data.

### Deferred / Flagged
1. **Side finding (PR #59):** existing utterance path allows duplicate
   `sequence_number` within a conversation (7 dev-DB cases of seq=1×2 from
   live-STT/segment-resume). Could be by-design or a latent double-insert bug.
   (memory: [[lct-utterance-sequence-number-not-unique]])
2. **#11 ADR-038 privacy boundary** — design-only, Proposed/NEEDS-WORK (F1:
   subprocess engines bypass the in-process chokepoint). The redaction-at-mirror
   guarantee P1 depends on. Big cross-repo build.
3. **Dead `DualView`/`ZoomControls` subsystem** (~8 files, ADR-004) — deletion
   candidate, flagged on PR #58, left for an explicit call.
4. **`.env.bak.tokenfix`** sitting untracked in `lct_python_backend/` (parallel
   session's; looks like an env backup — verify it's gitignored / not a secret leak).

## Key Context (non-obvious)
- **P1a contract:** `lct_python_backend/raw_turn_contract.py` (`RawTurnsPayloadV1`,
  pydantic v2, `extra="forbid"`, `redaction_applied` required); `persist_turns()`
  in `graph_persistence.py`; endpoint `POST /api/import/turns`; migration
  `p1_rawturn_dedup_indexes` (3 partial unique indexes, all scoped to RawTurn rows
  via `source_identifier IS NOT NULL`). Full rationale + the 5-round review log:
  `docs/plans/2026-06-17-p1-rawturn-data-contract.md`.
- **Redaction-at-mirror is an UPSTREAM precondition, NOT LCT-enforced** — a
  `redaction_applied` bool can't prove redaction; the real guarantee is ADR-038's
  stamp + leak-verify. LCT only enforces the `LCT_MIRROR_RAW`/`owner_local_raw` gate.
- **Dev-DB verification recipe + gotchas** (asyncpg missing from anaconda,
  `expire_on_commit=False`, downgrade after verifying, clean up `ITEST-*` rows):
  memory [[lct-dev-db-verification-recipe]]. DB = `127.0.0.1:5432/lct_dev`.
- **Parallel-session churn is live** — main's checkout hops branches
  (`fix/local-mode-graph-quality` → `feat/attendee-...` → `feat/synthetic-eval-harness`).
  Always build on a fresh worktree off `origin/main`; re-fetch before branch ops.
  ([[lct-repo-parallel-session-branch-churn]])
- **codex exec** is the review engine (`codex exec -s read-only "..."`); it produces
  a huge log (700KB+) — grep the tail for `Verdict`/`Blocking`. Reviews are GO/NEEDS-WORK.

## Learnings Captured
- [x] MEMORY.md + 3 new memories: `lct-rawturn-pipeline-p1-state`,
  `lct-utterance-sequence-number-not-unique`, `lct-dev-db-verification-recipe`
- [x] (earlier this session) `lct-diagnostic-logging-privacy-helpers`
- [ ] Skill gap: none new surfaced; the /impeccable + handover skills worked as-is.

## Running Processes / Background
- None of mine. (No long-running tasks left open; all codex reviews completed.)
- The dev Postgres `lct_dev` was migrated up then **downgraded back to `p0`** +
  test rows cleaned — it matches `main`'s schema. No action needed.

## Resume Instructions
1. Read MEMORY.md (auto-loaded) — the pipeline state + dev-DB recipe + seq-number
   finding are there.
2. If continuing the pipeline: pick **P1.5** (node↔utterance linking) — it's the
   LCT-side unblock that makes P0/P1 coverage real. Start by tracing where
   `node.utterance_ids` is populated in the extraction path.
3. For ANY new work: `git fetch origin` then create a worktree off `origin/main`
   (the main checkout is on the parallel session's branch — don't build there).
4. P1b needs the TemporalCoordination repo + fixing the unredacted-source bug first.

---
*Handover by Claude (Opus 4.8, 1M context) — `/handover` at session wrap. Context
healthy; user-requested.*
