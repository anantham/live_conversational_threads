# Handover: 2026-06-05 — ADR-034 merged + egress chokepoint (codex-hardened)

> File: `docs/HANDOVER_2026-06-05_adr-034-merge-and-egress-chokepoint.md`
> Author: Claude Opus 4.8 (1M). Session focus: finish "merge everything to main", culminating in hardening + merging the ADR-034 public-deployment security/tenancy branch.

---

## Session summary

Completed a multi-branch consolidation to `main` and then took on the parallel session's `docs/adr-034-public-deployment` security branch: merged main into it, fixed 3 conflicts, and — driven by **4 independent `codex exec` reviews** — closed real egress + owner-scoping + migration gaps, including building a **network-layer egress chokepoint**. All merged to `main` as a clean fast-forward. `main = 3aba1d6`, pushed, synced.

## TL;DR current state

- **`main` = `3aba1d6`, synced with origin.** No stashes. One worktree (the main checkout). No stray worktrees (mitigation worktree removed).
- **My work: 100% committed + pushed.** Nothing of mine uncommitted.
- **The working tree has 11 modified + 3 untracked files — these are the PARALLEL SESSION's in-flight STT/crux pipeline work, NOT mine. Do NOT commit them.** (Verified: they build on top of my committed work; my egress guards + chokepoint are intact, not reverted.)
- Test baseline: **1077 passed / 7 pre-existing failures / 0 regressions** (run cmd in §Repro).

## Commits this session (all on `main`, pushed)

Earlier consolidation (already on main before this session's ADR-034 focus): graph fix, ci/e2e gate, consumption/auth, `consumption_trigger`→experimental, upload-routing, ADR index/034, feat/e2e-audio-graph-zoom (converged at `d55b937`), `.tmp_*` gitignore (`ec64f42`).

ADR-034 branch (fast-forwarded into main, `ec64f42..3aba1d6`):
- `6dfc1a4` docs(adr-034): approve public LCT deployment (parallel session's)
- `7a2f462` fix(indrasnet): fail-closed capability gate (parallel session's)
- `c12233a` / `0ce9ae3` / `9065b02` tenancy + egress switch (parallel session's)
- `e887a2b` Merge main into branch (3 conflicts resolved: claim_detector deleted, bias_detector→gateway, INDEX ADR-034=Approved)
- **`7171cc7`** fix(adr-034): close egress-guard holes + owner-scoping write gaps (MINE)
- **`bae9354`** feat(adr-034): network-layer egress chokepoint (MINE)
- **`3aba1d6`** fix(adr-034): close urlopen import-binding egress gap (MINE)

## What landed (ADR-034)
- **Owner-scoped tenancy**: `services/owner_context.py` (resolve_owner_id seam), `models/identity.py` (users table), `alembic/versions/add_users_and_backfill_owner.py` (dialect-portable, idempotent), every conversation-create path routed through `resolve_owner_id()`.
- **Egress safety (two layers)**: per-site `services/egress_guard.py` (`assert_local_egress`) + **`services/egress_chokepoint.py`** — wraps `httpx.Client/AsyncClient.send` + `websockets.connect` + `urllib.request.urlopen` at startup (`backend.py` lifespan). Fail-closed by construction. `LCT_LOCAL_ONLY` default-on.
- Tests: `test_egress_chokepoint.py`, `test_egress_guard_coverage.py`, `test_owner_write_paths.py`, `test_egress_guard.py`, `test_owner_context.py`.

---

## Pending threads

### Continue immediately
_None of mine._ The merge mission is complete.

### Blocked / not-mine (DO NOT TOUCH)
1. **Parallel session's STT/crux pipeline work** — 11 modified files (`prompts.json`, `transcript_*.py`, `file_transcriber.py`, `transcription_utils.py`, `graph_persistence.py` is_crux wiring, `local_llm_client.py`, integration + unit tests) + 3 untracked docs (`docs/STT_BENCHMARK_2026-06-04.md`, `docs/STT_ORCHESTRATION_OVERHEAD_RCA.md`, `docs/plans/2026-06-05-stt-llm-pipeline-landing.md`). **Theirs to commit.** A concurrent session is actively editing `main`'s working tree. NEVER `git add -A` here — stage explicit paths only (memory: `lct-repo-parallel-session-branch-churn`, `parallel-agent-git-contention`).

### Verified safe (checked 2026-06-06, no action needed)
- **Backfill migration / owner-scoped-reads data-visibility risk — RESOLVED on the dev DB.** Concern was: owner-scoped reads hard-filter `owner_id == usr_aditya` with no fallback, so if the `add_users_and_backfill_owner` migration hadn't run, the next backend restart would show an EMPTY conversation list (looks like data loss). Checked the live `lct_dev` DB: `alembic_version = add_users_and_backfill_owner` (at head), all **64** real conversations are `usr_aditya`, **0 legacy-owner rows**, `users` table seeded. (7 `usr_test_harness` rows are correctly isolated test data, intentionally hidden.) The hazard is NOT live here. NOTE for OTHER environments (fresh clone, public VPS, the parallel session's box): the trap re-arms on any un-migrated DB — there is no auto-migrate on startup and no read fallback. Durable fix proposed but not built: a loud startup guard that warns/refuses if owner-scoped reads are on but the migration revision isn't applied (option C from the 2026-06-06 discussion; NOT a read fallback, which would weaken the IDOR fix).

### Deferred (acknowledged, parked)
1. **ADR-034 public-tenancy completeness** — only `list_saved_conversations` + `get_conversation` reads are owner-scoped. Canvas hierarchical export + other reads NOT scoped; no RLS yet. **Public ingress MUST stay disabled (`ENABLE_INDRASNET=0`) until done.** Plan: `docs/plans/2026-06-01-adr-034-step1-tenant-isolation.md`.
2. **Egress chokepoint boundaries** (documented in `docs/adr/ADR-034-egress-chokepoint-proposal.md`): GCS SDK not chokepoint-covered; google-auth (inbound, not egress); shell `curl` in start.command; non-server entrypoints (scripts/alembic/`.tmp_pipeline_telemetry`) don't install the chokepoint; installer failure is fail-open. All belt-and-suspenders for the public tier, not blockers for owner local-only.
3. **GCS lazy-import** (consciously parked by user): `gcs_helpers.py` does top-level `from google.cloud import storage` even in local mode → 5 *unrelated* tests can't collect (only `test_gcs_helpers_save_fallback` actually tests GCS). Fix = move import into the gcs-backend path. In TECH_DEBT.
4. **7 pre-existing test failures** (in TECH_DEBT): missing `google-cloud-storage` (6 files / collection errors), speaker-naming router not mounted (404), asyncio cross-pollution flake, `semantic_level` default. None caused by this session.
5. **Branch/ref cleanup**: `docs/adr-034-public-deployment` local branch fully merged into main (redundant, deletable). 6 `backup/*` refs on origin prunable when confident.

---

## Key context (non-obvious — would be expensive to rediscover)

- **codex review loop is the hero of this session.** `codex exec --config sandbox_mode="read-only" --config approval_policy="never" - < prompt` (runs gpt-5.5). Ran 4×; returned NO-GO 3× and caught **two real bugs I'd have shipped**: (a) per-site egress guards are leaky — it grepped and found ~8 unguarded paths after I fixed 4 → drove the chokepoint design; (b) the chokepoint's urllib patch was defeated by `from urllib.request import urlopen` (by-value import captured before lifespan install) → fixed with a per-site guard in `probe_health_url`. **Lesson: any `from x import network_fn` by-value import defeats a global monkeypatch chokepoint.**
- **The egress chokepoint works because OpenAI SDK AND google-genai SDK both ride httpx** — wrapping `httpx.*.send` covers them with zero SDK-specific code. Verified `google-genai _api_client` uses httpx, not requests.
- **Chokepoint MUST be uninstallable for tests** — `test_egress_chokepoint.py` installs the global class patch; without `uninstall_egress_chokepoint()` in a teardown fixture it leaked into 75 other tests (TestClient/MockTransport against non-local hosts all blocked). The fixture yields then uninstalls.
- **ADR numbering is tangled** (memory `lct-repo-parallel-session-branch-churn`): two ADR-021 files; ADR-032 has a stale "future ADRs" wishlist reserving 033-038 (mostly overrun); the inference-catalog ADR was renumbered 034→037 earlier this session-arc to avoid colliding with this public-deployment ADR-034.
- **Safety pattern used throughout**: worked in an isolated `git worktree` so `main` was never at risk; backed up the branch to `origin/backup/adr-034-pre-mitigations-20260605` before editing; explicit-path commits only.

## Repro: the test baseline
```bash
cd "C:/Users/adity/Documents/Ongoing Local/live_conversational_threads"
export DATABASE_URL="sqlite:///./test.db"
/c/Users/adity/anaconda3/python.exe -m pytest -p no:hypothesispytest lct_python_backend/tests/unit \
  --ignore=lct_python_backend/tests/unit/test_canvas_api_converter.py \
  --ignore=lct_python_backend/tests/unit/test_consumption_prayer_api.py \
  --ignore=lct_python_backend/tests/unit/test_conversation_export_api.py \
  --ignore=lct_python_backend/tests/unit/test_conversation_participants_api.py \
  --ignore=lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py \
  --ignore=lct_python_backend/tests/unit/test_thread_observability_api.py -q
```
Expected: **1077 passed, 7 failed** (the 7 documented pre-existing). `-p no:hypothesispytest` mandatory on this anaconda env.

## Running processes
None started by me. (A parallel agent/human session is live, editing main's working tree.)

## Resume instructions
1. `git fetch` + check whether the parallel session committed its STT work (the 11 uncommitted files). If still uncommitted, leave it alone.
2. The merge mission is DONE — no action needed unless the user opens a new thread.
3. If continuing ADR-034 → public tier: pick up `docs/plans/2026-06-01-adr-034-step1-tenant-isolation.md` (scope remaining reads + RLS), keep public ingress disabled.

---
*Handover by Claude Opus 4.8 at ~end of a long multi-phase merge session. main=3aba1d6, synced.*
