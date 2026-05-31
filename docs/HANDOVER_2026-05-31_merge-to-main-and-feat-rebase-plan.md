# Handover: 2026-05-31 — merge-to-main complete + next-session plan (failing tests + feat rebase)

> File: `docs/HANDOVER_2026-05-31_merge-to-main-and-feat-rebase-plan.md`
> Author: Claude Opus 4.8 (1M), merge-orchestration session.
> Purpose: (1) record what landed on `main` this session, (2) **file the 6 known-failing / non-running unit tests** with root causes, (3) give the next session a **concrete, citation-rich plan to merge `feat/e2e-audio-graph-zoom`** — the one large branch left unmerged.

---

## TL;DR state at end of session

- `main` = **`2f99913`**, pushed to `origin/main`, **in sync**. (Started this session at `4e313f3`.)
- Full unit suite on merged main: **1000 passed / 6 failed** (the 6 are identical at merge-base `4e313f3` AND tip → **pre-existing, not regressions**; +123 tests vs base).
- Branches **deleted** (all fully absorbed): `fix/graph-saved-view-overlap-clean`, `fix/graph-saved-view-overlap-and-zoom`, `ci/e2e-pr-gate`, `fix/lct-upload-local-first-routing`.
- **Only remaining branch:** `origin/feat/e2e-audio-graph-zoom` (NOT merged — needs a deliberate rebase, see §3).
- No stashes, no extra worktrees.

### What landed on main this session (over `4e313f3`)
| Commit | What |
|---|---|
| `73e2bef`, `2df0014` | Graph canvas fix (degenerate-timestamp spread; 360×280 node sizing; `MIN_READABLE_ZOOM=0.65`) — ff'd from the `clean` branch |
| `18f59f5`, `78b2c22`, `32b1cc0` | CI e2e PR-gate + nightly-STT workflows; `share_api` `db`→`db_session` import fix; 38 share_api unit tests |
| `799a4b4` … `cd63251` | 7 consumption/auth/docs commits (apiFetch auth header fix; ADR-033 verification edits; `.gitignore`; VESTIGIAL_CLEANUP; consumption archive; handover) |
| `90f8ee6` | **`consumption_trigger.py` → `lct_python_backend/experimental/`** (new non-prod package; test import + `@patch` retargeted; 2 prose comments + TECH_DEBT row repointed; 41 tests pass) |
| `1b2a5cf` | ADR INDEX: added rows for **ADR-032 (Accepted)**, **ADR-033 (Accepted)**, **ADR-034 (Proposed)**; added "Accepted" legend entry. Committed `ADR-034-public-lct-deployment-tiered-isolation.md` as **Proposed draft** (5 open redline decisions in that file §"Decisions still open") |
| `addc77f` | STT-orchestration + Modal kill-switch handover doc |
| `acc62ec`, `2f99913` | **Upload local-first routing**: `provider_selection.py` reorder so a configured local URL wins for uploads; quality-first test scoped to `upload_local_first=False`; new default-on test; docstring corrected |

> ⚠️ **Behavior change shipped:** `STT_UPLOAD_LOCAL_FIRST` (default `True`, in `services/transcription_utils.py` — *unchanged* by this work) now actually takes effect. Deployments with a configured local provider URL (e.g. parakeet `http://localhost:5092/...`) will route **uploads** to local first instead of OpenAI. Cloud remains reachable via `upload_remote_fallback`. `local_only=True` removes cloud entirely; `provider_override` still wins.

---

## 1. Reproduce the test baseline (next session, do this FIRST)

```bash
cd "C:/Users/adity/Documents/Ongoing Local/live_conversational_threads"
export DATABASE_URL="sqlite:///./test.db"
/c/Users/adity/anaconda3/python.exe -m pytest -p no:hypothesispytest lct_python_backend/tests/unit \
  --ignore=lct_python_backend/tests/unit/test_canvas_api_converter.py \
  --ignore=lct_python_backend/tests/unit/test_consumption_prayer_api.py \
  --ignore=lct_python_backend/tests/unit/test_conversation_export_api.py \
  --ignore=lct_python_backend/tests/unit/test_conversation_participants_api.py \
  --ignore=lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py \
  --ignore=lct_python_backend/tests/unit/test_thread_observability_api.py \
  -q
```
Expected on `main@2f99913`: **1000 passed, 6 failed**. (`-p no:hypothesispytest` is mandatory on this anaconda env — see memory `pytest-disable-hypothesis-plugin-on-windows`. `DATABASE_URL=sqlite` avoids the eager-engine import error.)

---

## 2. FILED: known test failures / non-running tests (all PRE-EXISTING — predate this session)

Verified pre-existing by the session's adversarial audit: each failure occurs **identically at merge-base `4e313f3` and at tip** → none caused by this session's merges. None of the failing files import `share_api`, `consumption_trigger`, or the graph files this session touched. (Also recorded in `docs/TECH_DEBT.md`.)

### 2a. Six COLLECTION ERRORS — `google-cloud-storage` not installed (env gap; ~50–100 tests silently skipped)
Fail at import (`ImportError: cannot import name 'storage' from 'google.cloud'`), so they are `--ignore`'d above and **do not run**:
`test_canvas_api_converter.py`, `test_consumption_prayer_api.py`, `test_conversation_export_api.py`, `test_conversation_participants_api.py`, `test_gcs_helpers_save_fallback.py`, `test_thread_observability_api.py`.
**Fix:** `pip install google-cloud-storage` into the anaconda env (or stub `google.cloud.storage` in a conftest). Until then, *"full suite passed" = "full suite minus these 6 files."*

### 2b. Four REAL failures (run, but fail)
1. **`test_conversations_api_relationship_maps.py`** (2) — `conversations_api.py` imports `google.cloud.storage`; same missing-lib root cause, fails at run not collection. Same fix as 2a.
2. **`test_speaker_naming_api.py`** (2) — `GET /api/conversations/{id}/speakers` → **404**. Root cause: test app includes `router` but **not `router_conversations`**, so the route isn't mounted. Test-harness bug. Fix: include the conversations router in the test fixture.
3. **`test_transcript_processing_runtime.py::test_graph_timer_forces_update`** (1) — asyncio teardown ("task destroyed but pending"); the **known "~69-test asyncio cross-pollution"** (passes alone, fails in full-suite). **NOTE:** `feat` commit `a214644` adds a `tests/unit/conftest.py` that isolates event loops per test — likely **fixes this** when feat merges. Verify post-merge.
4. **`test_transcript_processing_schema.py::test_normalize_generated_output_adds_required_defaults`** (1) — asserts `semantic_level == 2` but code defaults to `1` since `d5ca1ee` (2026-04-14, before merge-base). Align test or default.

### 2c. e2e status
- **No e2e run on merged main this session** (unit-only). Gap still open.
- Existing CI e2e smoke specs (from `18f59f5` `e2e.yml`): `initialization`, `d4-color-mode-smoke`, `d6-autosave-smoke`, `fullscreen-button`. Run once against merged main to close the gap.
- `feat` adds `lct_app/tests/e2e/audio-graph-zoom.spec.ts` (215 lines, audio→graph→levels). **Env-coupled** (local RTX-Whisper `100.81.65.74:7777` + local `gpt-oss-20b`; `CONVERSATION_ID` fast mode) — will go red off-LAN. See §3 blocker 3.

> Did NOT create `docs/ISSUES.md` on main: `feat` carries its own `ISSUES.md` (absent on main) — adding one now would cause an add/add conflict at feat-merge. This register + the TECH_DEBT rows are the interim home.

---

## 3. NEXT-SESSION PLAN: merge `feat/e2e-audio-graph-zoom`

### Correct coordinates (every prior input mis-stated these — `git fetch` first, then verify)
- **feat tip = `4966675`** (2026-05-30) — NOT `68f1c35`.
- **merge-base = `4e313f3`** (2026-05-25) — NOT `eafcffc`.
- **41 ahead / 16 behind** main (the 16 = this session's work) — NOT "8/33".
- **96 files, +5,498 / −6,326** (net −828: deletes a lot of dead code).
- ⚠️ Branch NAME is **misleading** — feat made **ZERO commits to `MinimalGraph.jsx`/`graphLayout.js`**. Its real value is below.

### What feat actually delivers (verified present on feat / absent on main)
- **Inference backend catalog + 3-lane settings**: `services/backend_catalog.py`, `backend_catalog_api.py`, `data/backend_catalog_seed.json`, `components/settings/{BackendCard,CapabilityLane,InferenceLanes}.jsx`, `useBackendCatalog.js`, `backendState.js`(+test). ADR-034-inference-catalog. (`437cd42`,`28d2374`,`96f8701`,`d467e81`,`58916a6`)
- **Crux detector e2e**: `services/crux_detector.py`, `pages/CruxAnalysis.jsx`, `services/cruxApi.js`, `analysis_api.py`. ADR-035. (`7430b41`,`7575add`,`0bb520b`) ⚠️ **Stub:** reads/serializes `is_crux` but **nothing sets it True** → crux page always-empty until a populator exists.
- **On-device local STT server**: `lct_python_backend/local_stt/server.py` (mlx-whisper) + README + requirements. (`00abed3`,`901fa3e`,`ce12ca5`)
- **LLM telemetry + diarization-config services**: `services/llm_telemetry_service.py`, `services/diarization_config.py`, `services/diarization_settings_service.py`. (`efe4a37`,`437cd42`)
- **Security hardening**: audio-upload path-traversal block + auth on share-revoke (`c685f86`), quota fail-closed (`873bcf1`), response-header + trusted-host (`a7257be`), HMAC share-URL signing test (`0137407`).
- **Detectors → LLM gateway** (`5b7fe9a`) + **large dead-code deletion** (claim/argument/is-ought detectors, `graph_generation.py`, orphaned thematic-zoom) (`f034e54`,`f6f660e`,`2519144`).
- **Event-loop isolation conftest** (`a214644`) — likely fixes failure 2b.3.
- **`docs/AUDIT_RATIONALITY_2026-05-30.md`** — 43-row stub/orphan inventory; good roadmap input.

### Approach: **rebase feat onto main** (not merge-as-is, not cherry-pick). 3 BLOCKERS — the first reviewer's "2 trivial conflicts / zero overlap" was WRONG (refuted by the fair judge):

**BLOCKER 1 (HARD) — graph files must take MAIN's side.**
feat's tree predates main's graph fixes, so its `MinimalGraph.jsx` / `graphLayout.js` are the **OLD pre-fix copies**. `git diff main origin/feat/e2e-audio-graph-zoom -- lct_app/src/components/MinimalGraph.jsx lct_app/src/components/graphLayout.js` is **non-empty** — feat's side would **REVERT** `MIN_READABLE_ZOOM`, 360×280 sizing, and degenerate-timestamp spread (`2df0014`+`73e2bef`). During rebase, **resolve both files to MAIN's version**, then visually confirm the saved-view graph renders before pushing.

**BLOCKER 2 (HARD) — ADR-034 number collision.**
- main: `ADR-034-public-lct-deployment-tiered-isolation.md` (Proposed, 2026-05-31) — shipped this session.
- feat: `ADR-034-inference-backend-catalog-and-three-lane-settings.md` (Decided, 2026-05-30) — different decision.
Renumber feat's catalog ADR (suggest **036**): rename file + its INDEX row + in-repo references. Reconcile status vocabulary ("Decided" vs main's "Accepted"/"Approved"/"Proposed").
- **Bonus pre-existing (feat commit `5d8872e` flags it):** main already has **two ADR-021 files** (`ADR-021-browser-local-draft-recovery.md` + `ADR-021-authored-four-level-conversation-hierarchy.md`, both indexed). Renumber one while touching INDEX.

**BLOCKER 3 (MEDIUM) — e2e env coupling.** `audio-graph-zoom.spec.ts` hardcodes `100.81.65.74:7777` + `gpt-oss-20b`. Parameterize via env / gate behind a `@local-only` marker / CI-skip, else CI goes red off-LAN.

**Also:** re-derive the FULL conflict set against true base `4e313f3`. Known doc conflicts: `.gitignore` (main adds `lct_python_backend/data/llm_telemetry.jsonl` — keep main's line), `docs/adr/INDEX.md` (take main's ADR rows/dates + feat's renumbered catalog ADR). `prompts.json`, `TECH_DEBT.md`, `WORKLOG.md`, `PROJECT_STRUCTURE.md`, `HANDOVER.md` also touched both sides — expect text conflicts.

### Rebase recipe (isolated worktree)
```bash
git fetch origin
git worktree add ../lct-feat-rebase origin/feat/e2e-audio-graph-zoom
cd ../lct-feat-rebase
git rebase origin/main
#  graph-file conflicts -> take MAIN's side (during rebase, main = --theirs):
#     git checkout --theirs lct_app/src/components/MinimalGraph.jsx lct_app/src/components/graphLayout.js
#  renumber ADR-034-inference -> 036; fix INDEX; parameterize e2e endpoints
# then: full unit suite (§1) + npx vitest run + the new e2e (locally)
```
> In `git rebase`, ours/theirs is inverted vs merge: `--theirs` = the branch you rebase ONTO (main). Diff before committing the resolution.

### Open questions for the user
1. ADR-034 collision: renumber feat's catalog ADR to 036 (recommended)?
2. Crux: ship as visible-but-empty stub, or hold the UI until a populator sets `is_crux=True`?
3. Confirm graph files resolve to main's side (reverses the first reviewer's wrong "zero overlap").
4. e2e env coupling: parameterize vs CI-skip?

---

## 4. Out-of-repo follow-ups (from the two prior 2026-05-31 handovers; status as of this session)
- **Modal kill-switch:** set `MODAL_WHISPERX_DISABLED=1` in `TemporalCoordination/grimoire/IndrasNet/.env` + restart IndrasNet — closes live-STT (CRITICAL priority) cloud-fallback leak (`MODAL_REQUIRE_APPROVAL_BELOW_PRIORITY=URGENT` cannot block CRITICAL). Memory: `modal-cost-gate-threshold-cannot-block-critical`.
- **`SHARED_AI_SERVICES.md` refresh:** stale `:8000`/`:7777`/`100.81.65.74` labels — see `docs/HANDOVER_2026-05-31_stt-orchestration-and-modal-killswitch.md` §"Verified box state".
- **`AGENDA_QUERY_DETECTOR_ENABLED=true`** left ON in `.env` — decide if it stays.
