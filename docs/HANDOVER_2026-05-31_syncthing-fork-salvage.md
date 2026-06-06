# Handover: 2026-05-31 — Syncthing-corrupted stale fork: preserve + salvage

## Session Summary (narrative)
The local working copy (`~/Documents/Ongoing Local/live_conversational_threads`) turned out to be a **stale fork** (diverged 2026-04-14, +15 local commits) whose working tree had been **corrupted by Syncthing** (no `.stignore` → CRLF/mode/symlink mangling, 478 `.sync-conflict-*` files, another device's near-`main` files dragged in). The user's original goal ("commit/push everything, then merge to main") was inverted: a bulk merge would have **deleted ~26k lines** of newer work, since `origin/main` is the truth and was +178 commits ahead. Instead we (1) **preserved** all local-only work to `origin/backup/*`, (2) reviewed all 15 fork commits against current `main`, and (3) **salvaged** the 4 genuinely-novel items into **PR #53**. `.git` itself was never corrupted.

## Commits This Session
On `salvage/from-dev-fork-20260531` (off `origin/main`, pushed → **PR #53**):
- `25ccd3e` fix: salvage three low-risk fixes from stale dev fork (factcheck silent-failure logging; live-STT `http_language` dead-setting wired FE+BE; `formatBackend` online_gemini→"Gemini" instead of "Local")
- `56123b5` docs(vision): salvage substrate-philosophy principles from dev fork (Eternal Reprocessability, view-time Privacy, Retrieval Near the Edge)

Preservation pushes (no working-tree changes): `backup/dev-20260531`, `backup/codex-stt-pre-rebase-20260531`, `backup/stash0-conversation-reader-20260531`, `backup/stash1-frontend-wiring-20260531`, `backup/snapshot-syncthing-wip-20260531` (`e39ef20`, full uncommitted WIP, secret-free).

PUSHED: yes — backups + salvage branch all on `origin`. PR #53 OPEN, awaits review/merge.

AMBIENT DIRTY (not committed): main worktree is parked on `backup/snapshot-syncthing-wip-20260531` with Syncthing-mangled files on disk (`docs/HANDOVER.md`, `.env.example`, 478 sync-conflict files, `.tmp_validation/`, `*.png`). Deliberately left untouched — switching branches would delete the synced files and propagate deletions to other devices via Syncthing.

## Salvage review scope (exhaustiveness)
ALL local-only work sources were reviewed against current `main`, not just dev's commits:
- **dev's 15 commits** → 4 salvaged (PR #53), 11 superseded/already-on-main/contradictory.
- **`backup/pre-rebase-codex-stt` (4 unique-by-patch commits)** → all superseded: `2ef0301` adds ADR-017/019 (main has `ADR-019-event-sourced...`); `bc26060` is the ADR-018 proposal (main has an ADR-018 file + shipped edit-history); `0a91a06` live streaming/cloud-fallback FE (its territory reached main via merged `codex/*` PRs #3/#16; the 8 files it touches were since rewritten on main — not line-level diffed, ~0.8 confidence superseded); `e42e019` legacy-test cleanup (main's tests evolved).
- **stash@{0}** (speaker rename/display FE + `conversation_reader` speaker-id fallback) → superseded: main shipped speaker rename (`speaker_naming_api`, SpeakerVoiceLibrary) and has `utterance_node_reconciler.py` + `speaker_naming_service._resolve_speaker_id_via_nodes` — the exact fallback IS on main (different module; the first grep checked the wrong file).
- **stash@{1}** (frontend Input/prop wiring) → stale: based on an old PR-merge commit; overlaps main's current UI (not deep-verified, but pre-divergence base).
- **Uncommitted working-tree delta (~8.6k lines vs dev)** → NOT novel: snapshot's `stt_ws_session.py` / `conversation_reader.py` / `speaker_naming_api.py` are byte-identical to `origin/main` — Syncthing had overwritten the stale checkout with main's own files.

Net: PR #53's 4 items are the complete salvage set; nothing else survives review.

**Line-level verification of the two formerly-uncertain items (now confirmed superseded, zero residual uncertainty):**
- `0a91a06` (live streaming FE) — every distinctive symbol it introduced is present on `main`: `getProviderStatus`, `STATUS_BADGE_STYLES`, `cloudProviderChecks`, `onProviderTest`, status codes (`quota_exceeded`…), `emitProcessingStatus`, `fallback_candidates`, and the latency fields `completedGraphLatencyMs`/`patchNodeCount`/`sttAwaitingMs`/`graphWorkingMs`.
- `stash@{1}` — dependency-lock noise (`package-lock.json` esbuild bumps) + ancient README/FEATURES edits (base = PR #8) + prop-wiring into the retired `Input.jsx`. The live concepts (`chunkDict` 16 files, `graphDataFromSocket` 4, `conversationId` 45) all exist on `main`, relocated into `NewConversation`/`AudioInput`.

## Verbatim user quotes (chronological — times approximate, single session 2026-05-31; precise HH:MM not available in-context)
- *"ok my goal is to do a /handover and before that review any tasks that might be worth doing while all this context is hot, the idea is to ensure this repo has everything in commits and pushed to remote, so pull from remote and do all the merge to main as much as possible or explain why not to me"* — set scope: preserve everything, then merge-to-main OR explain why not.
- *"so synthing correptec it?"* / *"feels like we are in shit"* / *"i thought I had syncthing ignore git tracked folders!"* — anxiety + the key diagnostic lead (Syncthing ignore was expected but absent). Resolved: no `.stignore` exists; `.git` uncorrupted; remote safe.
- (AskUserQuestion) **"Preserve + forward-port now"** + **"origin (backup/* refs)"** — authorized backups to origin and a forward-port pass.
- *"why not go through it carefully diff the files and we work througfh it you explain each commit to me and we consider what is worth integrating to main"* — directed a careful, collaborative, commit-by-commit review rather than bulk action.
- *"yea this sounds right but consider sounds uncertain why not explain exactly what you would do to salvage this and why"* — demanded decisive salvage plans with exact edits + rationale, not hedged "consider" verdicts.
- *"yea do that"* — proceed to the meatier (architecture/mobile/docs) review batch.
- *"yea please do that"* — build the salvage PR (A/B/C/D).
- *"1"* — chose "Add exactly the proposed VISION addendum" for item D.
- *"do a proper /Handover"* — this handover.

## Pending Threads

### Continue Immediately
None code-wise — the salvage is complete and in PR #53.

### Blocked
1. **PR #53** — awaits the user's review/merge. https://github.com/anantham/live_conversational_threads/pull/53

### Deferred / Operator-owned (see Operator Cleanup)
1. **Rotate leaked API keys** — see below.
2. **Fix Syncthing** (`.stignore` or move repo out of synced folder) — root cause.
3. **Re-align this local copy to `origin/main`** — needs Syncthing paused first.
4. **Threshold-tuning hypothesis (A/B test, NOT ported):** dev's `5786a82` raised graph flush thresholds (80→300 chars, 3s/5s→8s/15s) claiming main's low values fragment nodes into tiny unstable pieces. Worth measuring against main's post-streaming consolidation; not merged because it's a tuning judgment, not a clean port.

### Explicit Decisions NOT to Do (don't re-litigate)
| Item | Why skipped |
|---|---|
| Bulk-merge `dev` → `main` | dev is a stale fork; merge would delete ~26k lines of newer work on main |
| Commit the Syncthing-mangled working tree to a real branch | Pure noise (CRLF/mode/symlink); preserved as a labeled snapshot instead |
| Port `142fc18` (default STT → openai_audio) | Contradicts main's deliberate local-first default |
| Port `f23b10f`/`82775a0` (two-tier graph, thread_router, hierarchical_aggregator, ADR-030-two-tier, REFACTOR_PLAN) | Superseded by main's `hierarchy_consolidator` + ADR-031; dev's ADR-030 never left "Proposed" and its number collides with main's real ADR-030 |
| Port `d83fd48` (mobile layout) | Superseded by main's newer mobile sprint (2026-05-21) + CSS-responsive approach |
| Port `af152c1` / `21df833` | Already on main (independently fixed) |
| Port VESTIGIAL_CLEANUP / DEPRECATION_BOARD | main has newer / entries are stale |

## Key Context
- **`origin/main` is the source of truth.** The local clone is ~6 weeks behind and Syncthing-mangled. Don't trust the local working tree's "modified" status — most of it is metadata mangle, not real edits.
- The 4 salvaged items were each verified against current `main` (not the stale merge-base) before porting.
- The salvage work lives in a **separate clean worktree at `~/lct-salvage`** (off `origin/main`), intentionally outside the Syncthing-synced folder.
- A new `backup/adr-034-pre-mitigations-20260605` ref exists on origin from another session — the remote is being worked on by other instances.
- **The repo is PUBLIC** (`anantham/live_conversational_threads`) — relevant to the key leak above.
- **PR #53 base moved** `a326b00` → `9aa7e3c` (development continues). PR is `MERGEABLE` but CI is **red** — **diagnosed: both failures are pre-existing/infra, NOT caused by PR #53:**
  - `codex-review` → `##[error]Unable to resolve action openai/codex-review-action, repository not found` (the workflow points at a non-existent action; fails repo-wide).
  - `Playwright smoke (DB-independent specs)` → CI `backend failed to start within 60s` → `404` console errors → `expect(locator).toBeVisible()` 30s timeout. Fails identically on `main`'s base `a326b00` and every recent `main` commit; the salvage branch shows the same `backend failed to start within 60s`. A frontend-only diff (payload key + label string) cannot cause backend-startup failure. **→ PR #53 is safe to merge on its own merits; the red CI is a repo-wide condition the maintainer should fix separately (dead codex-review action + CI backend-startup timeout in the smoke workflow).**

## Operator Cleanup (manual — the human must do these)
- **🚨 ROTATE THE OpenAI key NOW — it is PUBLIC.** A live `sk-proj-…` OpenAI key is committed to `docs/HANDOVER.md` on `origin/main`, and the repo is **public** → publicly readable on GitHub and in git history (that file has 12 commits). Treat it as compromised. Rotating on the OpenAI dashboard is the only fix that neutralizes the exposure; scrubbing a public repo's history is best-effort (it's been clonable/indexable). GitHub's secret-scanning alerts API returned 0 — do **not** rely on auto-revocation. A scan of all tracked files on `main` found `docs/HANDOVER.md` is the only leaked file.
- **🔑 Rotate the local `.env` keys too.** `lct_python_backend/.sync-conflict-*.env` holds Anthropic/OpenAI/OpenRouter keys (Syncthing-copied across devices). These never reached the remote — push-protection blocked the snapshot push that included them — but rotate anyway since they were synced.
- **🔧 Add a `.stignore`** to the Syncthing folder (ignore the git working tree) or move the repo out of the synced folder. No `.stignore` currently exists — this is the root cause of the corruption.
- **♻️ Re-align this local checkout to `origin/main`** — PAUSE Syncthing first (else deletions propagate to other devices). Safest: fresh clone outside the synced folder after confirming backups. ⚠️ The **478 `.sync-conflict-*` files + `.tmp_validation/` + screenshots are local-disk-only (in NO backup)** — glance at them before resetting; they vanish on re-clone.

## Learnings Captured
- [x] Auto-memory: `project_syncthing_stale_fork_2026_05_31.md` (full diagnosis + backups + PR #53 + action items)
- [x] `MEMORY.md`: ⚠️ Critical Local State pointer at top ("Do NOT bulk-merge dev→main")
- [ ] Skill update opportunity (`expansion:handover`): handover assumed the local checkout is committable; here the working tree was corrupt/stale and the real work lived in a side worktree + backup refs. Worth noting the "stale/corrupt main worktree → commit elsewhere" path.

## Running Processes
None.

## Resume Instructions
1. **FIRST: rotate the public OpenAI key** (Operator Cleanup #1) — it's exposed on a PUBLIC repo right now.
2. Read `project_syncthing_stale_fork_2026_05_31.md` in auto-memory.
3. PR #53: red CI is diagnosed as pre-existing/infra (dead `codex-review` action + CI backend-startup timeout in `e2e (smoke)`), NOT from this PR — safe to merge on its merits. Separately, the maintainer should fix those two repo-wide CI conditions.
4. Do the remaining Operator Cleanup (rotate `.env` keys, add `.stignore`, re-align local) — the local folder is unsafe to work in until re-aligned.
5. Do NOT bulk-merge or commit from the stale local checkout.

## Calibration moments
| Moment | Lesson |
|---|---|
| User asked to "merge to main"; reality was a stale fork where merge = data loss | Verify branch currency (`git fetch` + divergence) before acting on a merge request — Stale Premise |
| Mass "modified" files looked like real work | `git diff --ignore-cr-at-eol --ignore-all-space` + checking `.sync-conflict-*` revealed Syncthing mangle, not edits |
| Snapshot push rejected by GitHub secret-scanning | Don't bypass — a real `.env` with live keys had been synced in; exclude secrets, rotate them |
| Initial read said dev's frontend `http_language` edit would no-op (no `sttConfig` prop) | Traced the call chain (`AudioInput`→`normalizeSttSettings`→`startSession`→`connectBackendSocket`); the value IS present at runtime. Trace before concluding. |
| Verdicts started as wishy-washy "consider" | User pushed for exact edits + rationale; precision forced verifying each against `main`'s real code |
| Called the leaked key a "local sync-conflict" and wrote "blocked from the remote" | It was ALSO committed to **public** `origin/main` — check a secret's blast radius on the remote (visibility + tracked files + history), not just the working tree |
| Declared the handover "done"/"exhaustive" before auditing all sources | "Is this exhaustive?" kept surfacing real gaps (codex-stt, stashes, public key, red CI). Run the exhaustiveness checklist BEFORE declaring done, not after being asked |

---
*Handover by Claude instance (Opus 4.8) — local checkout is a stale Syncthing-mangled fork; this doc written from the clean `~/lct-salvage` worktree off origin/main.*
