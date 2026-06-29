# Handover Index

Newest-first list of the **dated handover files** in `docs/`. Status legend (from the
2026-06-21 staleness audit — every pending item cross-checked against merged-PR history):

- 🟢 **current** — newest, accurate
- 🟡 **partial** — core work merged, but specific threads are still live (listed)
- ✅ **archived** — all pending items merged or superseded; reference/history only

> **The newest session work (2026-06-20) is NOT in this folder.** Two session handovers live in
> Claude **auto-memory** (the LCT checkout was isolation-guarded and `.claude/handover/` is gitignored):
> (a) the **M5 provider-fix + live-WS scored e2e** (`m5_ollama` was pointing at the box's own
> Tailscale IP → silent 0-node graph-gen; fixed live to gemma4 @ the Mac M5; 21-node scored run); and
> (b) the **token-incident / supervisor-takeover** close-out. **Forward tracks** carried by both:
> ADR-030 conversation_pipeline cutover · ADR-027 DB-canonical prompts · ADR-038 privacy boundary
> (design done, GO-gate No-Go, redesign proposal at `docs/plans/2026-06-20-adr-038-enforcement-redesign.md`).

---

- 🟢 `HANDOVER_2026-06-25_stt-fluidaudio.md` — **STT → FluidAudio + mobile-UX.** Replaced the
  hallucinating chunked-whisper live STT with a **FluidAudio/parakeet drop-in service** (clean,
  ~115× realtime, no "Fuhal" loops); **LIVE** via Tailscale-serve `:5443`→`:5096`. Quota disabled,
  empty-transcript→no-speech (#105). Shipped #91–#105 + ADR-058 (identity). **LIVE OPERATIONAL
  STATE + restart cmds are in the file — read before touching STT** (none of it is in git).
  Open: commit the still-untracked FluidAudio service, the provider-label/real-fallback "clean fix",
  FluidAudio supervision (launchd-ANE wall → nohup), diarization (#2), #12 topic-stack rail,
  #13/#14 identity (ADR-058), #10 cost dashboard.

- ✅ `HANDOVER_2026-06-19_public-deploy-token-incident.md` —
  Token rotated (new `F7G6br…` → 200, old `nid1L4…` → 401-dead), leaked token scrubbed from all
  current branch trees (survives only in deep history `44408fc`), env backups deleted, app verified
  green end-to-end. Incident closed. Secondary issues (CORS-masks-401, cold-start gate false-negative,
  retry storm) logged to `ISSUES.md` via PR #68 — durable fixes are pre-existing ADR-034 backlog.

- 🟡 `HANDOVER_2026-06-17_p1a-rawturn-pipeline.md` — RawTurn ingest pipeline. **Merged:** #59 P1a
  structured-turns ingest (`POST /api/import/turns`, `raw_turn_contract.py`, dedup migration), #56
  diagnostic-logging privacy, #58 ZoomControls fix, #57 stack; **#63 P1.5 node↔utterance linking now
  SHIPPED** (real coverage). **Live threads:** **P1b** IndrasNet PULL/PUSH (cross-repo, open
  `TemporalCoordination#17`); **P2** `lct_pipeline/` package (kill the `.tmp_*` scripts) + CI lint.
  The 🔴 "unredacted-source" bug it flagged was a **stale claim** (no live leak; corrected in PR #68).
  Contract + review log: `docs/plans/2026-06-17-p1-rawturn-data-contract.md`.

- 🟡 `HANDOVER_2026-06-07_threads-viewer-ux-crossconvo-privacy.md` — `.threads` viewer UX sprint
  (8 features live on threads.adityaarpitha.com) + cross-conversation "Two Minds" map + the frontier
  privacy pipeline **proven** (redact → codex-on-pseudonyms → restore → leak-verify). **Merged:** #10
  dialectic layout (`e0739e3`), #12 WhisperX parity + initial-prompt builder. **Live thread:** **#11
  productionize the privacy boundary** — became **ADR-038** (design done → GO-gate No-Go on the R1/R3/R5
  mechanisms → redesign proposal `2fb5e53`; implementation gated).

- ✅ `HANDOVER_2026-06-05_adr-034-merge-and-egress-chokepoint.md` — ADR-034 public-deploy plan +
  the network-layer **egress chokepoint** (wrap `httpx`/`websockets`/`urllib` at startup) merged.
  Deferred SDK/curl/non-server-entrypoint boundaries acknowledged in-doc; GCS test-collection unblocked
  later by `58bf4f3`. No live threads.

- ✅ `HANDOVER_2026-05-31_merge-to-main-and-feat-rebase-plan.md` — procedural: the `feat`→`main` merge
  plan (test-failure register + 3 rebase blockers: graph-file conflict → main's side; ADR-034→037
  renumber; e2e env coupling). Plan executed; branch merged. History only.

- ✅ `HANDOVER_2026-05-31_stt-orchestration-and-modal-killswitch.md` — STT orchestration trace through
  IndrasNet `:7777`, Modal kill-switch (`MODAL_WHISPERX_DISABLED=1`) identified, graph saved-view canvas
  overlap fixed (`eb29f22`, `5c9c6ed`). All merged.

- ✅ `HANDOVER_2026-05-31_consumption-verify-pass-and-auth-fix.md` — consumption manual-toolbar
  browser-verified, auth-header injection fix (`27e3391`), `get_async_session` import port, ADR-033
  verification. PR #51 merged.

- 🟡 `HANDOVER_2026-05-30_inference-catalog-3lane-settings-crux-techdebt.md` — inference backend catalog
  + 3-lane Settings UI + per-provider telemetry + crux detection (ADR-037/035), 2 security fixes, a
  `surface-tech-debt` dead-code purge, and a codex review pass. All catalog/settings/crux work merged.
  **Live threads:** the **two-LLM-config seam** (lane edits `llm_config`; graph-gen reads the
  `llm_providers` list) reconciliation; **FluidAudio diarization sidecar** never built.

- ✅ `HANDOVER_2026-05-25_auto-detect-and-staleness-audit.md` — wired auto-detect agenda-query into the
  live STT path (#17), wrote ADR-033, resolved fallback `_consumption_contact_ref` from participants.
  Also audited+corrected the 2026-05-18 entry. 4 commits, all pushed.

- 🟡 `HANDOVER_2026-05-23_no-audio-guards-e2e-quota.md` — no-audio guards (stop streaming dead-air to
  OpenAI), STT usage accounting wired (`record_usage`), e2e de-flake, `chunks`→`moments` cleanup. All
  merged (incl. de-flake `e5f0543`). **Live thread:** **#29 Playwright config consolidation** (low pri).

- ✅ `HANDOVER_2026-05-21_reconciler-and-mobile-fixes.md` — live utterance↔node reconciler, NodeDetail
  Speaker-section retirement, Part H rename UI, private-beta gate, 3 mobile fixes, single-speaker
  auto-assign (`638eb57`). All pushed; the mid-doc CORS thread was backend-down (resolved, no code).

- ✅ `HANDOVER_2026-05-20_participant-picker-pause-resume.md` — participant picker (+ ad-hoc guests),
  contacts cache, mobile footer, Vercel/Tailscale, LCT under the IndrasNet supervisor, and
  segment-and-stitch pause/resume — all shipped end-to-end. Lossless graph round-trip fixed (`b9d5d59`).

- 🟡 `HANDOVER_2026-05-20_adr032-speaker-rename.md` — ADR-032 swim-lane layout, semantic edge taxonomy,
  enrichment pipeline, windowed speaker rename (rename itself shipped `dd8ee43`/`4fe154c`). **Live
  threads:** #85 tier auto-promote; ADR-032 Parts B/I/J/L (multi-row ribbon, animations, telemetry,
  canvas swim-lane embed); #98 OpenAI `word_timings`.

---

*Index refreshed 2026-06-21 after a full staleness audit (general scope: every pending item
cross-checked against the merged-PR history; `.claude/worktrees/.../docs/HANDOVER*.md` are identical
git-worktree snapshots — duplicates of these files). The pre-2026-05-20 **inline** entries
(2026-05-18 / 2026-05-17 / 2026-04-03) were removed — fully superseded, recoverable from git history
(`git show <old-commit>:docs/HANDOVER.md`); the 2026-05-17 block also carried a stale partial API-key
prefix. New handovers should be **dated files** in `docs/`, not appended here.*
