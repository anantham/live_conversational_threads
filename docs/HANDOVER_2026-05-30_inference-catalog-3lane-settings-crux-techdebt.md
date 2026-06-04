# Handover: 2026-05-30 — Inference catalog + 3-lane Settings + crux + tech-debt + Codex review

## Session Summary (narrative)
Long autonomous session on branch `feat/e2e-audio-graph-zoom`. Built the **inference backend catalog** + a **3-lane Settings UI** (STT / Diarization / LLM) showing per-backend model · where-it-runs · empirical speed/accuracy · cost · live probe (ADR-037), added **per-provider LLM telemetry**, and **crux detection** (ADR-035, lights up the pre-existing `is_crux` amber UI). Fixed **2 real security holes** (audio path-traversal, share-revoke auth bypass). Ran a **`surface-tech-debt`** sweep (the `anantham/expansion` plugin skill) → **deleted dead code** (claim/argument/is_ought detectors+APIs, `graph_generation.py`, orphaned frontend incl. the whole ThematicView subtree, 8 orphan prompts) and **consolidated bias/frame/simulacra detectors onto `LlmGateway`** (dropped the hardcoded-`claude-3-5-sonnet` anthropic branch). Then ran an independent **`codex exec review`**, fixed its 5 findings, **re-reviewed**, and fixed the one regression that re-review caught. ~22 commits, all **on the branch, not pushed**. The user has a **parallel uncommitted "prayer-cards" feature** I never touched.

## Commits This Session (93a2d8a..HEAD, 22 — grouped)
- **Catalog/Settings/telemetry/crux:** `437cd42` catalog+diarization config · `efe4a37` LLM speed telemetry · `28d2374` 3-lane Settings + status chips · `7430b41` crux detection (ADR-035) · `efecb93` docs: rationality audit
- **Security/quality:** `c685f86` audio path-traversal + share-revoke auth · `873bcf1` quota fail-closed · `0137407` share-signing tests · `5d8872e` ADR INDEX 032–035 + ADR-021 collision · `a7257be` prod security headers wired · `91e1c1a` tests (catalog/telemetry/backendState)
- **Surfacing + detector field fix:** `62354eb` fix(analysis) detectors read Node.summary/key_points (were node_summary/keywords — non-existent) · `7575add` Analyze menu + crux page · `eed6418` README Quickstart
- **Refactor cleanup:** `f034e54` delete dead detectors/APIs/graph_generation · `f6f660e` delete orphaned frontend + thematic view · `5b7fe9a` detectors→LlmGateway · `a214644` test: per-test event-loop isolation conftest · `2519144` trim ThematicAnalyzer + prune 8 prompts
- **Codex-review fixes:** `d467e81` catalog admin-gate + LLM selected-vs-effective split · `58916a6` honest cloud/whisper selection + crux CTA · `0bb520b` crux state reset across conversations

**PUSHED: no — awaits user authorization.**

## Verbatim user quotes (chronological; no JSONL timestamps available — session order)
- *"ok lets do /handover anythign worth doing now while context is hot?"* — triggered this handover; wants high-marginal-value captures.
- *"ok lets do refactors I give approval"* — authorized the LLM-routing-consolidation refactor.
- *"like maybe we dont need vestigial dead code paths"* — reframed the refactor to **delete-first** (delete vestigial branches/modules rather than refactor them). Key directive.
- *"before you extract BaseNodeDetector … explain the state of the repo"* — wanted the live-vs-dead picture before acting.
- *"can you get codex to review this work via exec"* then *"did you do one more review? now that you fixed it?"* — values an **independent reviewer** AND re-review after fixing.
- *"All 5"* (fix scope for Codex findings) / *"nah its fine"* (declined gating the prayer-detect WIP endpoint — it's their in-progress feature).
- Earlier arc (catalog/settings): *"I want you to review the settings and look into that"*, *"we need similar statistics for the LLM intelligence we use also right"*, *"can we also make the UI more simplistic and minimal? … progressive disclosure"*, *"why does it say planned? is it done?"* (caught the FluidAudio ACTIVE+planned+red-dot contradiction → drove the honesty model).

## ADRs Written This Session
- **ADR-037: Inference Backend Catalog & Three-Lane Settings** — seed+refine catalog, 3 lanes, server-side SSRF-safe probe, honesty model (green = probe-verified).
- **ADR-035: Crux Detection** — graph-level detector via LlmGateway sets `Node.is_crux` + rationale in `display_preferences["crux"]`; no migration.

## Pending Threads

### Continue Immediately
1. **Push / open PR** — 22 commits unpushed on `feat/e2e-audio-graph-zoom`. Not authorized yet.

### Blocked (on user)
1. **Prayer-cards WIP is the user's** — do not commit/edit. Codex flagged a **P1**: `/api/conversations/{id}/prayer-detect` (`consumption_prayer_api.py:148`) isn't admin-gated → in `ADMIN_AUTH_TOKEN`-only mode, anonymous callers get IndrasNet private-memory results. User said *"nah its fine"* for now; revisit when they commit that feature (fix mirrors the catalog admin-gate — add a "contains `/prayer-detect`" check to the admin gate). Also: the new prayer-card files (`PrayerCardChip/Drawer.jsx`, `prayerCardsApi.js`) are untracked — must be committed *with* the `NewConversation.jsx` wiring or a fresh checkout/CI breaks.

### Deferred (acknowledged, parked)
| Item | Sketch / why |
|---|---|
| **Two-LLM-config reconciliation** | The LLM lane edits `llm_config` (drives detectors/crux via `local_chat_json`), but live graph-gen (`generate_lct_json_local`) uses the **`llm_providers` list** (first enabled; online→Gemini) and ignores `llm_config`. Surfaced **honestly** via `active.llm` (selected) vs `active.llm_effective` (graph-gen reality) + the lane's "Serving now: X" banner. The full fix = make the lane edit the providers list (reorder/enable) so selected==effective. Bigger rework. |
| **`thematic_api` now frontend-orphaned** | After deleting `ThematicView`, no frontend calls `/api/conversations/*/themes*`. `thematic_api` + `hierarchical_themes` clusterers + `ThematicAnalyzer._serialize_existing_structure` may be fully dead (MinimalGraph reads levels elsewhere). Verify what reaches `/themes/*`; if nothing, scope deleting the subsystem. Judgment call — left mounted. |
| **FluidAudio diarization sidecar** | Chosen default diarizer is `status:"planned"` — the Swift/CoreML ANE sidecar (`:5096`) isn't built. Catalog/lane/probe/config exist; runtime doesn't. Build it (+ contact-mapping + voice enrollment) for real on-device diarization with embeddings. |
| **Cloud-LLM / non-default-Whisper selection (fuller fix)** | Codex #3/#4 fixed by **honest warn → Advanced** (can't fake a switch you can't configure from the lane). Fuller fix: cloud needs a key (Advanced Providers); whisper variants need an endpoint — could add an `stt_engine_id` field + providers reorder so the lane can truly switch them. |
| **`conversations_api.py` ledger correction** | TECH_DEBT.md row says "RESOLVED→193" but the file regrew to **831 LOC** (misleading). Quick doc fix — but `TECH_DEBT.md` is currently the user's dirty WIP, so left it. Do once their TECH_DEBT edits land. |
| **`share_api` DB/Google-token flow tests** | Signing is now tested (`test_share_api_signing.py`); the revoked/expired→410/404 + unverified-email→403 flows still need AsyncSession+Google mocks. |
| **`.env.example` undocumented vars** | ~50 production env vars read by code but absent from `.env.example` (incl. SESSION_SECRET_KEY, DIARIZATION_*, INDRASNET_*). Document grouped by subsystem + a test asserting code-referenced ⊆ documented. |
| **3 JSON-repair parsers** | `local_llm_client` / `edge_enrichment` / `perplexity_factcheck` each hand-roll brace-recovery with divergent tolerance. Promote one `llm_json_extract`. |
| **Monolith splits** | `stt_ws_session.py` (3308), `import_bulk_pipeline.py` (1523), `MinimalGraph.jsx` (1550), `ServiceStatus.jsx` (~810 after this session). Tracked in TECH_DEBT. |
| **`conversation_pipeline/` cutover** | Built+tested orchestrator (ADR-030 §D3), imported only by tests; the monoliths it was meant to replace still run. Finish-or-delete decision (judgment call, not touched). |

### Explicit Decisions NOT to Do (don't re-litigate)
| Item | Why |
|---|---|
| Extract a `BaseNodeDetector` | After deleting the dead anthropic branch, each detector's LLM call is ~10 lines — a base class would be over-engineering (YAGNI). |
| Delete the dead detectors' DB models/tables (Claim/ArgumentTree/IsOughtConflation) | Dropping them is a schema migration — out of scope. Code deleted; models left. |
| Auto-gate / edit the prayer-cards WIP | User said "nah its fine"; it's their uncommitted feature. Flagged only. |

### Carried forward from prior handovers
- **OpenAI API key rotation** (2026-05-17 handover) — `lct_python_backend/.env` may still hold a local-only key; rotate in the OpenAI dashboard if not already done. (Not echoed here.)
- **`consumption_trigger.py` mothballed** (2026-05-18) — still intentionally uncommitted; revive only if implicit-detection path becomes interesting.

## Key Context (non-obvious — read before LLM/Settings work)
- **THE LANDMINE — two LLM configs.** `llm_config` (mode/base_url, `.env` `LOCAL_LLM_BASE_URL`) drives **detectors + crux + accumulate** (via `local_chat_json`). The **`llm_providers` list** (Advanced → Providers; default first-enabled = Tailscale LM Studio `100.81.65.74:1234`) drives **graph-gen + consolidators** (via `gateway().chat`). `generate_lct_json_local` *ignores* `llm_config`. So your `.env` Ollama may NOT be what graph-gen runs. The catalog now shows both (`active.llm` selected vs `active.llm_effective`); see memory `lct-llm-config-seam`.
- **Detectors route through the gateway now** (`local_chat_json`), no hardcoded model. Online mode = **Gemini** specifically (`generate_lct_json_gemini`).
- **Catalog honesty model:** green "ACTIVE" = probe-verified running only; selected-but-not-running = amber; cloud/unprobed = neutral. `backendState.js` (`runState`/`isServing`) is the single source; don't reintroduce status-only green.
- **Catalog seed** lives at committed `lct_python_backend/data/backend_catalog_seed.json` (benchmark facts). LLM telemetry log `data/llm_telemetry.jsonl` is gitignored.
- **Test suite ordering:** unit tests mix `asyncio.run()` (new) and `asyncio.get_event_loop().run_until_complete()` (old). `tests/unit/conftest.py` gives each test a fresh loop. Run backend tests with `DATABASE_URL='postgresql+asyncpg://u:p@localhost:5432/db'` set for files that import `stt_api`/`share_api`/`backend.py` (import-time engine init); `test_thread_observability_api.py` needs a real DB (pre-existing).
- **Codex review pattern (reusable):** `codex exec -s read-only review --base <sha>` reviews the working-tree diff vs `<sha>` — note it sweeps in uncommitted WIP too. gpt-5.5, read-only is safe. It caught 5 real edge-case bugs my happy-path tests missed.
- **AMBIENT DIRTY (not mine, not committed):** the prayer-cards WIP — `PrayerCardChip/Drawer.jsx`, `prayerCardsApi.js(.test)`, edits to `NewConversation.jsx`, `consumption_prayer_api.py`, `indrasnet_client.py`, `TranscriptSelectionToolbar.jsx`, `SttSettingsCard.jsx`, `TECH_DEBT.md`, `WORKLOG.md`. Leave untouched.

## Operator Cleanup (manual)
- **Restart `./start.command`** to pick up backend changes; ensure **Ollama** (or the configured provider chain) is running for graph-gen/crux/detectors.
- The new analysis is on-demand: open a saved conversation → **Analyze ▾** (header) → Cruxes/Biases/Frames/Simulacra. Settings → Runtime → "Inference runtime" lanes.

## Learnings Captured
- [x] Memory `lct-llm-config-seam.md` (project) — the two-config landmine.
- [x] Memory `lct-session-working-style.md` (feedback) — verify-before-delete, delete-vestigial, never-touch-parallel-WIP, independent-Codex-review-then-re-review.
- [x] `MEMORY.md` index updated.
- [x] ADR-037, ADR-035 written; INDEX updated (+ ADR-021 collision flagged).
- [x] `docs/AUDIT_RATIONALITY_2026-05-30.md` (8-agent audit) committed.

## Calibration moments
| Moment | Lesson |
|---|---|
| User caught FluidAudio showing green ACTIVE + red dot + "Planned" | Status ≠ running. Drove the probe-verified honesty model; never key "green" off status. |
| My first honesty fix still went green for cloud/pre-probe (Codex #1/#2) | One shared run-state rule; "green = probe-verified" must be the *only* path. |
| My crux-CTA fix leaked `analyzed` across conversations (re-review #3) | Reused component instances need per-route state reset. **Re-review after fixing pays off.** |
| Implementing Codex #2 surfaced the two-config seam | Don't "make active=providers" — model selected-vs-effective + surface the gap honestly (diarization pattern). |
| `git rm` is atomic — one missing path aborted the whole batch | Verify pathspecs exist before multi-file `git rm`. |

## Resume Instructions
1. Read this doc + the two new memory files (auto-loaded via `MEMORY.md`).
2. If the user wants to ship: `git push` (22 commits) / open PR — **needs explicit go-ahead.**
3. Don't touch the prayer-cards WIP; if asked to help it, the P1 prayer-detect admin-gate is the first thing.
4. Highest-value next builds: FluidAudio sidecar (real diarization), or the two-LLM-config reconciliation (make the LLM lane edit the providers list).

---
*Handover by Claude Opus 4.8 (1M context). Context not at compaction threshold; user requested explicit /handover. 22 commits, unpushed.*
