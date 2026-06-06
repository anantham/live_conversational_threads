# Handover Index

The newest handovers are **dated files** in `docs/` (newest first):

- `HANDOVER_2026-06-07_threads-viewer-ux-crossconvo-privacy.md` — `.threads`
  viewer UX sprint, 8 features shipped + live on threads.adityaarpitha.com
  (fan-out drill-down, canvas-only focus mode, dynamic+collapsible header,
  in-context "who said what" drawer, timeline progress %, plain-language
  tooltips, /browse public opener, **Argument-status color mode**). Cross-
  conversation intelligence: 5-meeting interconnections + a 23-meeting /
  15-month "Two Minds" relationship map (codex GPT-5.5 extraction beats local
  qwen's edge ceiling). **Privacy frontier pipeline PROVEN** (redact via
  IndrasNet REDACTION_MAP → codex on pseudonyms → restore → leak-verify;
  `vatsal_gpt5_private.threads`) and shared with Vatsal, who's now a
  collaborator. Pending: #11 productionize the privacy boundary + ADR, #10
  Phase-2 dialectic layout, #12 vocab→WhisperX re-transcription. **Landmine:**
  a parallel session has uncommitted MinimalGraph cold-open fix + WORKLOG/
  DESIGN/PRODUCT/impeccable — don't clobber.

- `HANDOVER_2026-05-30_inference-catalog-3lane-settings-crux-techdebt.md` —
  built the inference backend catalog + 3-lane Settings UI + per-provider LLM
  telemetry + crux detection (ADR-037/035); fixed 2 security holes (audio
  path-traversal, share-revoke auth) + quota fail-closed + wired prod security
  headers; ran `surface-tech-debt` → deleted dead code (claim/argument/is_ought
  detectors+APIs, graph_generation, orphaned frontend incl. ThematicView, 8
  prompts) + consolidated bias/frame/simulacra detectors onto LlmGateway; then an
  independent `codex exec review` + its 5 fixes + a re-review (caught 1 regression).
  **22 commits, NOT pushed.** Key landmine: the two-LLM-config seam (lane edits
  `llm_config`; graph-gen uses the `llm_providers` list — surfaced via "Serving
  now"). User's parallel **prayer-cards** feature is uncommitted + untouched
  (Codex flagged a P1 auth gap on `/prayer-detect` there). Open: push/PR, two-config
  reconciliation, thematic_api now frontend-orphaned (deletion candidate),
  FluidAudio sidecar not built.
- `HANDOVER_2026-05-25_auto-detect-and-staleness-audit.md` — audited the
  2026-05-18 inline entry (substantially stale: 3 done, 2 superseded, 2
  still pending); closed both real pending items by wiring auto-detect
  agenda-query into the live STT path (#17) and writing ADR-033 (#9).
  Bonus: resolved fallback `_consumption_contact_ref` from conversation
  participants, closing ADR-033 limitation #3. 4 commits, all pushed.
- `HANDOVER_2026-05-23_no-audio-guards-e2e-quota.md` — no-audio guards A+B
  (stop streaming dead-air to OpenAI), STT usage accounting wired
  (`record_usage` was never called), e2e suite triage + partial de-flake,
  `chunks`→`moments` terminology cleanup. 7 commits, all pushed. The
  2026-05-21 CORS thread is **closed** (backend was just down — now up).
  Open: finish e2e de-flake (#30) + config consolidation (#29).
- `HANDOVER_2026-05-21_reconciler-and-mobile-fixes.md` — live utterance↔node
  reconciler, NodeDetail Speaker-section retirement, Part H rename UI,
  private-beta gate, the three mobile fixes (#114/#115/#116) — all pushed.
  Ended mid-CORS-thread; that thread is resolved in the 2026-05-23 handover.
- `HANDOVER_2026-05-20_participant-picker-pause-resume.md` — participant picker
  (incl. ad-hoc guests), contacts cache, mobile footer, Vercel/Tailscale, LCT
  under the IndrasNet supervisor, and segment-and-stitch pause/resume **shipped
  end-to-end**. Updated 2026-05-21; ends with the remaining work flagged by
  context-sensitivity.
- `HANDOVER_2026-05-20_adr032-speaker-rename.md` — ADR-032 swim-lane layout,
  semantic edge taxonomy, enrichment pipeline, windowed speaker rename.

Older entries (2026-05-18, 2026-05-17, 2026-04-03) are stacked below in this
file — kept for history; new handovers should be dated files, not appended here.

---

# Handover: 2026-05-18

> **STALENESS NOTE (audited 2026-05-24):** Several items below are out of date.
> Audit results:
> - Frontend MVP (line 70): **DONE** — chip/drawer/toolbar wired in `NewConversation.jsx`
> - Auto-detect path / task #17 (line 78): **DONE (2026-05-24)** — `consumption_match_runner.py` wired into `stt_ws_session._persist_event` final branch; gated on `AGENDA_QUERY_DETECTOR_ENABLED`; 14 runner tests + 51 detector tests pass
> - WS event tasks #5, #8 (line 79): **SUPERSEDED** — picker-nudge rides on `second_speaker_detected` (`stt_ws_session.py:1551` → `audioMessages.js:55`, commits 71e3b01 + d26e4dd). New `consumption_match` WS event added 2026-05-24 for the auto-detect path.
> - Session-start contact picker / task #18 (line 80): **DONE** — `ParticipantPickerModal` (82ea2e0); deferred + auto-nudged in 71e3b01 + d26e4dd
> - ADR / task #9 (line 81): **DONE (2026-05-24)** — `docs/adr/ADR-033-consumption-prayer-matching.md`
> - IndrasNet typed-accessor migration (line 82): **DONE**
> - IndrasNet server restart for `detect_types` fix (lines 63-68): **DONE**
> - `consumption_trigger.py` mothballing (line 91): **STILL UNCOMMITTED**
>
> For work after 2026-05-18, see the dated handover files listed at the top of this index.

## Session Summary
Built the consumption-prayer MVP end-to-end across LCT + IndrasNet (sibling repo at `..\TemporalCoordination\`). Manual-trigger UX: speaker selects a sentence in the live transcript → floating toolbar with prayer-type slots → "Show agenda with [contact]" → POST to LCT proxy → IndrasNet reads `## Pending discussions` from contact's Obsidian note → chip + drawer render results. While doing this, also found and fixed two unrelated IndrasNet 500s (sqlite `detect_types` crashing on T-format timestamps; `/api/settings/watched-folders` crashing on `json.loads` of an already-parsed list). Both fixes still need a server restart to deploy.

## Commits This Session

**LCT (`live_conversational_threads`):**
- `1f9e20e` feat(lct): async IndrasNet HTTP client for cross-repo prayer queries
- `6aa6459` feat(consumption): pending-discussions client + agenda-query phrase detector
- `036bd50` feat(agenda-detector): expand phrase list + name-grounded watch list
- `9f3e19e` feat(consumption-prayer): manual-trigger endpoint for the live UI selection toolbar
- `06db257` chore(scripts): e2e verification harness for consumption-prayer read path
- `32267e2` feat(consumption-prayer): frontend MVP — chip, drawer, selection toolbar
- `7d84f6e` docs(issues): capture consumption-prayer pending work + remove dead e2e script

**TC / IndrasNet (`TemporalCoordination`):**
- `fc3b3c8` test(contact_note): test suite for `core/contact_note.py` (the file itself was bundled into parallel-agent commit `1e850f9`)
- `75f85ad` feat(prayers): append Confirmed Remind/Connect to participants' contact notes
- `195a441` feat(pending-discussions): GET endpoint + backfill script
- `68868cc` feat(scripts): bulk-populate contacts.obsidian_note_path from display_name (NOTE: this commit accidentally bundled in parallel-agent `scripts/backup_indrasnet_db.py` + tests)
- `f3e63be` fix(db): drop `detect_types` — TIMESTAMP/DATETIME columns now return strings
- `d50644e` fix(settings): handle both shapes get_setting() can return for watched_folders (bandaid)
- `fe015db` refactor(settings): explicit typed accessors `get_setting_str` / `get_setting_json` (proper fix superseding `d50644e`)
- `f3db493` fix(db): add get_setting_str + get_setting_json to `__all__`
- `85e2ef4` docs(issues): capture LCT-integration session findings

**~340 unit tests pass across both repos. 0 fail. All pushed locally; none pushed to origin.**

## Pending Threads

### Continue Immediately

1. **User wants to share another conversation with the IndrasNet agent.** They asked for a `/handover` first, so this is the literal next move. I noted that the parallel agent has been busy this session (commits to telemetry, contacts perf materialization, transcription quality gates, google-auth, trust-boundaries audit) — if the new convo is recent it may reference work I haven't read yet. **Resume:** wait for them to paste a path or text; read it; pick up wherever they want to take the consumption-prayer / vision conversation next.

2. **IndrasNet server restart needed to deploy 3 fixes.** PID 41280 (`python -m grimoire.IndrasNet.agents.web_server`) is on pre-fix code. Until restarted:
   - `/api/contacts*` returns 500 (`detect_types` ValueError on T-format timestamps)
   - `/api/settings/watched-folders` returns 500 (TypeError on already-parsed list)
   - The Integrations UI shows "Failed to load watched folders"
   
   **Resume:** `Stop-Process -Id 41280` — start_all.py (PID 41904) should respawn it. After respawn, hit `http://127.0.0.1:7777/api/contacts/Mom/pending-discussions` to confirm 200 with `status=note_missing`.

3. **Frontend MVP not yet browser-verified.** Components are syntactically clean, follow LCT React conventions (JSX + Tailwind v4 + PropTypes), 93 backend tests cover the API contract — but the live render is unverified. **Resume:** `cd lct_app && npm run dev`, open `/new`, drag-select any sentence in transcript, walk through toolbar → contact picker → "go" → chip → drawer. Smoke-test risks documented in LCT `ISSUES.md`: selection-rect positioning on narrow viewports, drawer animation collision with `animate-slideIn`, chip z-index against other floating overlays.

### Blocked

None right now — all open threads are decisions-pending or design-pending rather than waiting on external systems.

### Deferred

1. **Auto-detect path (task #17).** `agenda_query_detector.py` (51 tests, name-grounded + 56 phrases) is built but not wired into `stt_live_runtime`. Manual-trigger MVP is sufficient; auto comes back when we want voice-triggered surfacing. Decision-pending: WS-push vs HTTP-poll architecture for the trigger-to-frontend flow.
2. **WS event emission + handler (tasks #5, #8).** Manual path uses HTTP response → state update. WS only needed when auto-detect lands.
3. **Session-start contact picker (task #18).** Selection toolbar has its own per-selection picker; session-level may be unnecessary.
4. **ADR for consumption-prayer design (task #9).** Design lives in commit message bodies + 5 memory files. Promote to ADR after the design weathers real use.
5. **IndrasNet `get_prayer_agent_config` + `/api/settings/` migration to typed accessors.** Both work on the polymorphic legacy `get_setting`; migrating to `get_setting_json` would be no-functional-change explicitness cleanup. Noted in TC `docs/indrasnet/ISSUES_AND_GAPS.md`.
6. **Historical participant resolution gap (deeper).** Backfill writes 0 for the 1 historical Confirmed Remind/Connect because its participant is `{contact_id: NULL, display_name: 'Self'}`. The consumption-prayer feature populates organically only from NEW conversations. The upstream fix is in IndrasNet's voice-resolution / participant-tagging pipeline. Not blocking us; flagged for IndrasNet team.

## Key Context

- **This machine `Asus-Strix-Scar` IS the IndrasNet host** (`100.81.65.74` on Tailscale). So `G:\My Drive\Exocortex` (the user's vault, where contact notes live) resolves identically from the IndrasNet server's perspective and from this PowerShell session's perspective.
- **226 contacts now have `obsidian_note_path` configured.** Done this session via `scripts/populate_contact_note_paths.py --apply`. Paths under `G:/My Drive/Exocortex/Contacts/{sanitized_display_name}.md`. Collisions accepted: Bob×2, Alice×2, Vishnu GT×2, plus the `*_Voice` test-fixture contacts.
- **Two new memory files created this session** (in addition to the ones from prior sessions): `indrasnet-settings-typed-accessors`, `indrasnet-db-timestamp-strings`, `parallel-agent-git-contention`. See `MEMORY.md` for the full index — that file is always loaded into context.
- **The parallel agent has been actively committing during this session.** Their files sometimes get bundled into my commits via wide `git add` behavior — see the `parallel-agent-git-contention` memory entry for mitigations. Commit `68868cc` is the cleanest example (correctly named for my work but contains 2 extra files from their working tree). Not destructive; just messy attribution.
- **LCT mothballed files stay uncommitted on disk:** `lct_python_backend/services/consumption_trigger.py` + `tests/unit/test_consumption_trigger.py` — implicit-detection LLM gate, 41 tests pass, intentionally not committed because we picked explicit-verbal-trigger as MVP. Available to revive if the implicit path becomes interesting.
- **Encoding gotcha:** Python on Windows defaults to cp1252; any script that prints non-ASCII (Devanagari, IAST diacritics, arrows) must `sys.stdout.reconfigure(encoding='utf-8')` at script start. See `windows-cp1252-utf8-bug-class` memory.

## Learnings Captured

- [x] Memory: `indrasnet-settings-typed-accessors.md` — prefer get_setting_str / get_setting_json; legacy get_setting polymorphism preserved for back-compat
- [x] Memory: `indrasnet-db-timestamp-strings.md` — sqlite3 connection deliberately omits `detect_types`; parse with `parse_db_timestamp` when needed
- [x] Memory: `parallel-agent-git-contention.md` — chain stage+commit in one bash invocation; verify `git diff --cached --name-only` before every commit
- [x] `MEMORY.md` index updated with the three new entries
- [x] LCT `ISSUES.md` updated with consumption-prayer pending work + server-flap operational note
- [x] TC `docs/indrasnet/ISSUES_AND_GAPS.md` updated with 5 findings: server-restart-needed, settings migration backlog, data-shape gap, server flapping, commit attribution
- [ ] Skill update opportunity: none surfaced this session that wasn't already in the skill defs

## Running Processes (as of session end)

- **IndrasNet web server** — PID 41280 — listening on `0.0.0.0:7777`. **On pre-fix code; restart to deploy today's fixes.**
- **LCT backend (uvicorn)** — PIDs 34572 + 38796 — listening on `0.0.0.0:43181`. Loaded the new `consumption_prayer_api.py` if restarted today; otherwise needs restart too.
- **WhisperX inbox watcher** — PID 15972 — processing audio inbox at `C:\Users\adity\Downloads\transcription_transfer\inbox`.
- **start_all.py autostart supervisor** — PID 41904 — respawns IndrasNet if it dies.
- **Various multiprocessing children** (parent_pid=41280, 40900, 47784, 41796) — IndrasNet's agent workers (beeper, obsidian, meet).

## Resume Instructions

1. **Read this handover doc** and the 5 LCT memory files (auto-loaded via `MEMORY.md`).
2. **Wait for the user** — they explicitly said the next move is sharing a conversation with the IndrasNet agent about LCT consumption prayers. Don't pre-empt; they'll paste a path or text.
3. **When the new convo arrives**, scan it for: (a) any new design constraints on the consumption-prayer flow, (b) work the parallel agent already did that affects our paths, (c) requests for me to act on its content.
4. **If the user instead asks "did the fixes deploy"** — run `Stop-Process -Id 41280; Start-Sleep 5; Test-NetConnection 127.0.0.1 -Port 7777` and check `/api/contacts/Mom/pending-discussions` returns 200 with `status=note_missing`.
5. **If the user wants browser-verify** — `cd lct_app; npm run dev`, open `/new`, follow the smoke-test steps in LCT `ISSUES.md`.

---
*Handover by Claude Opus 4.7 (1M context) at end of long session — context usage high but not at compaction threshold; user requested explicit /handover.*

---

# Handover: 2026-05-17

## Session Summary
Tech-debt scan + multi-batch cleanup. Started with `/surface-tech-debt`
(7-dimension audit) — found critical security gaps (no auth, live API
key on disk), 4 monoliths >1400 LOC, several architectural redundancies,
and a latent NameError in an unused endpoint. Shipped 9 atomic commits
addressing 14 distinct items: secrets/auth hardened, dead code purged
(412 LOC Claude path + shim + broken endpoint + 4 dead files), ~1,700+
LOC moved into 8 focused helper modules, vitest framework added,
~170 new unit tests, ADR-031 documents the consolidation pipeline.
Stopped at honest stopping point — remaining items either need 2-3 hour
focused sessions (SessionConfig refactor) or user-side decisions
(prompts dual store, fate of formalism endpoint).

## Commits This Session (all on `main`, NOT pushed yet)
- `6d2f670` chore(debt): adopt env_helpers in 5 safe sites (I, partial)
- `7d11eb1` C: extract CircuitBreaker subsystem from RealtimeHttpSttSession
- `0426786` A+B+D: delete dead endpoint, set up vitest, extract MinimalGraph clustering
- `efbf176` refactor(llm): delete dead Claude path in llm_helpers (M1)
- `5199bd9` chore(debt): retry_policy — unify the ad-hoc retry loops
- `78d60d3` chore(debt): env_helpers — kill the os.getenv().strip().lower() boilerplate
- `3d8b265` chore(debt): tuning constants + upload/SSRF defense-in-depth
- `7fa3f67` refactor(monoliths): extract pure helpers from 3 of the 4 big files
- `f3f31d2` chore(debt): cheap-wins batch — tests, encoding fixes, file rename

**PUSHED: no** — 9 commits ahead of origin/main. Push requires explicit user
go-ahead; previous handover (2026-04-03) had been pushed to a feature branch
but this session was directly on `main`, so push needs care.

## Pending Threads

### Bigger Investments (Each Its Own Focused Session)
1. **SessionConfig refactor → complete C** — 2-3 hrs, intricate but bounded.
   The remaining 810-LOC `RealtimeHttpSttSession` class in
   `lct_python_backend/services/stt_http_transcriber.py` has deep state coupling
   between config (provider/model/language/session_id/conversation_id), buffer
   state, VAD state, and per-provider transcription methods. Extracting an
   `SttSessionConfig` dataclass would enable moving the 3 per-provider methods
   (`_transcribe_backend_http_candidate`, `_transcribe_openai_audio_candidate`,
   `_transcribe_openrouter_audio_candidate`, ~250 LOC) to a new
   `stt_provider_transports.py` module. Risk: touches active STT path; needs
   careful test sweep after.
2. **Worker test scaffolding** → unblocks the 1415-LOC `run_bulk_processing_worker`
   mega-function split in `import_bulk_pipeline.py`. ~1 day to write integration
   tests covering each stage (uploading / transcribing / analyzing / chunking /
   consolidating / persisting / exporting), then ~1 day for the split itself.
3. **WS test scaffolding** → unblocks the 2508-LOC `WsSessionContext` class in
   `stt_ws_session.py`. The 12 TODOs in `tests/integration/test_audio_websocket.py`
   need real bodies first. ~1 day for tests, ~2 days for class decomposition.
4. **Frontend further extraction** — `MinimalGraph.jsx` is now 1156 LOC (down
   from 1799). The remaining LOC is the React component proper. Further work
   would extract event handlers and effect logic — needs careful state analysis.

### Slogs (Hours of Low-Leverage Work)
5. **M7 narrow bare excepts** — 124 catches across 45 files. The 59 in API
   routes are largely appropriate (terminal HTTP-500 handlers). The 65 in
   services are mixed: maybe 20-30 actually swallow real bugs. File-by-file
   audit needed; each catch is a small judgement call.
6. **Incremental env_helpers/retry_policy adoption** — 17 remaining env-var
   sites all have subtle semantic differences (narrower truthy sets, fail-loud
   vs silent-default for int parsing). Each migration is its own judgement.
   Helper exists, can be adopted opportunistically when each file is next
   touched.

### User-Side Decisions Required
7. **L4: prompts dual store** — `prompts.json` (hot-reload) coexists with the
   DB-backed prompts table (versioned). Pick one as canonical, migrate. Decision
   has UX implications (hot-reload convenience vs DB consistency).
8. **`/generate_formalism/` endpoint fate** — currently DELETED in commit
   `0426786` because handler called undefined `generate_individual_formalism`
   (NameError). If feature is wanted, restore from history and implement the
   missing function. If not, deletion stands.
9. **OpenAI API key rotation** — `lct_python_backend/.env` line 22 still
   contains `sk-proj-LIzt9JLBmS4NavJ41oLKitdq_KJ...`. `.env` was verified
   never committed to git history, so exposure is local-only. User needs to
   rotate the key in OpenAI dashboard and paste the new one.

## Key Context

### Architecture Insights Discovered This Session
- **`local_chat_json` is a delegating shim, not a competing LLM client.** It
  already routes through `gateway().chat()` per ADR-030 §D5 (see
  `services/local_llm_client.py:240-260`). The "three competing LLM modules"
  framing in the original scan was inaccurate. Architecture IS consolidated.
- **`local_chat_json` callers (12 sites) can stay as-is.** Migrating them to
  `gateway().chat()` directly would add ~3 lines per site (need
  `provider_from_legacy_config(config)` + capability enum + `.data` unwrap).
  Net code added, only marginal value (explicit capability at call site).
- **The per-provider STT methods can NOT be extracted as pure free functions
  yet.** Each references `self.session_id`, `self.conversation_id`,
  `self.provider`, `self.model`, `self.language` for fallback defaults and
  logging context. Needs `SttSessionConfig` extraction first.

### Files / Modules Created This Session
- `lct_python_backend/services/env_helpers.py` (90 LOC, 36 tests) — env_str,
  env_bool, env_int, env_float, env_str_or_none
- `lct_python_backend/services/retry_policy.py` (~150 LOC, 13 tests) —
  retry_async_with_backoff, retry_sync_with_backoff, compute_backoff_delay
- `lct_python_backend/services/tuning_constants.py` (~80 LOC) — named
  thresholds with rationale: STREAMING_CONTEXT_WINDOW_SIZE,
  REFINEMENT_HIGHER_TIER_LOSS_THRESHOLD, MIN_IDEAS/TOPICS/THEMES_FOR_*,
  DEFAULT_TAB_MIN_COMPRESSION_RATIO
- `lct_python_backend/services/stt_response_parsers.py` (~150 LOC) — 5
  provider-response parsers (WhisperX, OpenAI, OpenRouter)
- `lct_python_backend/services/stt_circuit_breaker.py` (231 LOC, 31 tests) —
  CircuitBreaker class + error classifiers
- `lct_python_backend/services/import_bulk_helpers.py` (~150 LOC) — ffprobe,
  duration formatting, backend-label resolution, retry classification
- `lct_app/src/components/graphLayout.js` (130 LOC, 7 tests) — Dagre +
  swim-lane layout
- `lct_app/src/components/graphNormalization.js` (114 LOC) — node
  normalization, contextual relation extraction
- `lct_app/src/components/graphClustering.jsx` (415 LOC) — L1/L2/L3 cluster
  builders, cluster-to-RF view
- `docs/adr/ADR-031-post-streaming-hierarchy-consolidation.md`
- `lct_python_backend/tests/unit/test_hierarchy_consolidator.py` (19 tests)
- `lct_python_backend/tests/unit/test_prompt_manager.py` (4 tests)
- `lct_python_backend/tests/unit/test_import_security_guards.py` (28 tests)
- `lct_app/src/components/graphLayout.test.js` (7 tests, first vitest test)

### Files Deleted This Session
- `lct_python_backend/services/live_graph_persistence.py` — DEPRECATED shim
  per ADR-030 §D3, zero importers
- `lct_app/src/components/GenerateFormalism.jsx` — only caller was
  archive/TranscriptApp.jsx (also dead)

### Files Renamed This Session
- `services/factcheck_service.py` → `services/perplexity_factcheck.py`
- `services/fact_check_service.py` → `services/openai_factcheck.py`

### Security Hardening Applied
- `AUTH_TOKEN=nid1L4Zo4quG7HOK3cUPkIX6F8NB90A3JC65mMfR0k8` (32-byte random)
  set in `lct_python_backend/.env`
- Matching `VITE_AUTH_TOKEN` written to `lct_app/.env` (gitignored, verified)
- `DEBUG=false` in `.env`
- Content-type whitelist on `/api/import/process-file` (audio + text suffixes
  allowed; rejects unknown filename+ct combinations)
- SSRF defense-in-depth: `assert_url_resolves_to_public_host` in
  `services/import_validation.py` does DNS resolution + blocks loopback,
  RFC1918, link-local, IMDS. Called by `download_url_text` regardless of
  the upstream `validate_import_url` check.

### Test Infrastructure
- Vitest 3.2.4 + jsdom 25 installed as frontend dev deps
- `npm test` runs vitest, `npm run test:watch` watches
- Vitest config in `lct_app/vite.config.js` (jsdom env, src/**/*.test.{js,jsx})
- e2e (Playwright) stays separate under `tests/`

### Pre-existing Issues Discovered (Not Caused This Session)
- 69 unit tests fail when run with full suite, all pass individually. Asyncio
  event-loop teardown issue in some fixture. Verified pre-existing (same
  pass/fail counts on the cheap-wins commit base).
- `generate_formalism` in `llm_helpers.py` referenced undefined
  `generate_individual_formalism` — endpoint would NameError. Whole endpoint
  was deleted, but if it's wanted back the implementation needs to be written.

### Untracked Files Not Mine
`lct_python_backend/services/consumption_trigger.py`,
`indrasnet_client.py`, and their tests — these existed before this session and
were left untracked throughout. Not part of this session's commits.

## Resume Instructions

1. **First**: rotate the OpenAI API key (only thing in this session that
   needs human action). Replace `sk-proj-LIzt9JLBmS4...` in
   `lct_python_backend/.env` line 22.
2. **Then restart backend + frontend** so `AUTH_TOKEN` and `VITE_AUTH_TOKEN`
   take effect. Backend log should show
   `[SECURITY] Auth: ENFORCED (all non-health routes)`.
3. **Verify with browser** that the conversation list loads (proves frontend
   is sending the bearer token correctly).
4. **Push when ready**: `git push origin main` — 9 commits to publish.
5. **Pick next item** based on bandwidth:
   - 2-3 hr block: SessionConfig refactor (continue C)
   - 1 day: write WS or worker test scaffolding (unblocks H1/mega-function split)
   - 30 min: decide on /generate_formalism (delete-confirmed or restore-and-implement)
   - 1-2 days: pick prompts dual-store canonical and migrate

## Learnings Captured
- [x] Auto-memory: `user-prefers-honest-scope-reduction` — feedback memory
- [x] Auto-memory: `user-prefers-staged-commits-with-honest-partial-framing` — feedback memory
- [x] Auto-memory: `windows-cp1252-utf8-bug-class` — project memory
- [x] ADR-031: post-streaming hierarchy consolidation documented
- [x] INDEX.md backfilled with ADR-030 and ADR-031

---
*Handover by Claude Opus 4.7 (1M context) at session end*
*Previous handover preserved below*

---

# Handover: 2026-04-03

## Session Summary
Major graph UX overhaul: progressive graph generation during file upload (nodes appear in ~30s instead of 30+ min), app-scoped upload context surviving page navigation, card-style graph nodes with summaries, context-sensitive legend, fuzzy edge resolution, minimizable transcript panel, and numerous UI improvements. 17 of 18 tasks completed.

## Commits This Session
- `1b55362` feat: progressive graph gen, app-scoped upload, graph UX overhaul
- `fda5878` ci: add Codex code review workflow
- PUSHED: yes, to `feat/graph-ux-progressive-upload` branch
- PR: anantham/live_conversational_threads#49 (open, awaiting Codex review)

## Pending Threads

### Continue Immediately
1. **Codex review on PR #49** — `@codex review` comment posted but review hasn't triggered. May need to verify Codex GitHub App is installed on the repo (GitHub → Settings → Applications). Code review quota shows 100% available so it's not a quota issue.

### Re-validated
1. **Test buffered refinement pipeline for speaker diarization (#12)** — Previous handover note was stale. Verified on 2026-04-08 that the remote Windows machine at `100.81.65.74` has `TemporalCoordination/grimoire/IndrasNet` present and serving `POST /api/transcribe` from `agents/routes/transcription.py`. That route calls `gpu_backends.transcribe_with_coordinator(...)` with local WhisperX first, Modal WhisperX fallback, `priority=0`, and `coordinator_timeout=5.0`. Remaining work is latency and queue-path validation, not basic WhisperX availability.

### Deferred
1. **BYOK popup on rate limit** — BYOK moved to settings but no popup-on-limit yet. Needs backend signal for quota exhaustion. Low priority.
2. **Full color settings UI** — Edge/node colors hardcoded in graphConstants.js. Fuzzy matching fixed most missing edges. Settings UI deferred.
3. **Manual conversation rename** — Auto-derive from nodes works. Editable title in header not yet built.

## Key Context
- **Branch**: `feat/graph-ux-progressive-upload` based on `codex/fix-stt-cloud-test-observability`
- **Progressive gen architecture**: `on_chunk_progress` in `import_bulk_pipeline.py` accumulates transcript text in `progressive_buffer`. Every ~400 chars, calls `processor.handle_final_text()`. After STT completes, if progressive nodes exist, skips redundant re-analysis loop.
- **Upload context**: `UploadContext.jsx` at App level owns `useFileUploadStream`. Pages subscribe/unsubscribe via `subscribe()` / `unsubscribe()`. Buffered data consumed on mount via `consumeBuffered()`.
- **Two ByokContext files**: `byokContext.js` (lowercase, exports raw context + useByok hook) and `ByokContext.jsx` (uppercase, exports ByokProvider). Import with explicit `.jsx` extension to avoid Vite case-sensitivity issues.
- **Empirical ETA**: `.run/stt_timing_history.json` stores per-backend transcription ratios. First run shows "Calibrating...", subsequent runs show empirical estimate.
- **Timer spam fix**: `transcript_processing.py` had a tight loop when deferred flush timer re-fired with 0ms remaining. Fixed with 2s backoff.
- **Node detail panel bug**: `selectedNodeData` was searching only `latestChunk` (last array element). Fixed to search `allNodes` (flat across all chunks).
- **Duplicate edge keys**: Bidirectional edges (A→B and B→A) produced same key. Fixed with sorted pair + relation type dedup.

## Task List Status (18 total)
### Completed (17)
1. Progressive graph generation during file upload
2. Mini transcript in minimized state (closed captions style)
3. Move BYOK to settings
4. Center button should set readable zoom level
5. Remove zoom preset buttons
6. Move UI tips to settings
7. Timeline ribbon: show timestamps on hover
8. Edge labels and colors (fuzzy resolution)
9. Status pills wired to upload state
10. Verify themes clustering
11. Clean up debug console.logs
13. Conversation auto-rename from nodes
14. Larger graph nodes with summary text
15. Context-sensitive legend
16. Transcript panel light theme
17. Timestamp formatting above line
18. Curved cluster edges

### Remaining (1)
12. Test buffered refinement pipeline (pending: remote IndrasNet WhisperX route exists; validate latency, diarization output, and fallback behavior)

## Learnings Captured
- Progressive gen on cloud STT transport works well — don't need to segment the audio, just segment the transcript
- ReactFlow `const` declaration ordering matters — useEffect deps can't reference variables declared later (temporal dead zone)
- `fitView` with `minZoom` parameter prevents over-zooming on center
- Fuzzy name matching (exact → case-insensitive → substring) dramatically improves edge resolution
- App-scoped context is the right pattern for background tasks in React — page-scoped hooks die on unmount

## Running Processes
- Backend and frontend were started via `start.command` but the background task completed (services may have stopped). Restart with `bash start.command` from project root.

## Resume Instructions
1. Check if Codex review triggered on PR #49
2. If not, investigate GitHub App installation for `live_conversational_threads`
3. Start the app (`bash start.command`) and test the full flow with a file upload
4. Verify: nodes appear progressively, transcript panel works, cluster levels render, edges have colors
5. Test diarization pipeline (#12) against the active IndrasNet route at `100.81.65.74`, and inspect `/api/gpu/status` plus coordinator fallback behavior if latency remains high

---
*Handover by Claude Opus 4.6 at end of session*
