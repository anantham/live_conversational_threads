# Handover: 2026-05-31 — STT orchestration trace + Modal kill-switch + graph layout fixes

> File: `docs/HANDOVER_2026-05-31_stt-orchestration-and-modal-killswitch.md`
> Author: Claude Opus 4.7, ~73% context.
> Not yet committed — written direct to disk to survive compaction.

---

## Do these NOW (context-hot — cheap with this session's findings, expensive to rediscover)

1. **Set `MODAL_WHISPERX_DISABLED=1` in `TemporalCoordination/grimoire/IndrasNet/.env` and restart IndrasNet web server.** Closes the live-STT cloud-leak hole — see §"Modal kill-switch" below. The current `MODAL_REQUIRE_APPROVAL_BELOW_PRIORITY=URGENT` already blocks NORMAL/BACKGROUND/IDLE (so uploads are safe), but live STT runs at **CRITICAL** which the threshold cannot block. Trivial change; future-me would have to re-trace the cost gate.
2. **Update `TemporalCoordination/docs/SHARED_AI_SERVICES.md` GPU-box section** with verified 2026-05-30 ground truth (see §"Verified box state"). The current doc says `:8000` parakeet → 404 and labels `:7777` as STT — both incorrect/stale.
3. **Decide branch handling for `fix/graph-saved-view-overlap-and-zoom`** — it now has 10 commits, only 3 mine. Either cherry-pick the 3 graph commits (`c5e6eda`, `eb29f22`, `5c9c6ed`) onto a fresh branch off `main` for a clean PR, or accept the bundled push. Branch decision was the open item from earlier; the parallel-agent landed 7 more commits since.
4. **Add `_backend` canary logging in LCT** wherever it calls a transcribe-style endpoint, so you can see at runtime whether responses came back `local_whisperx` (safe) or `modal_whisperx` (leaked). Trivial today (the field is documented in §"Verified box state"); future-me would have to re-trace.

## Can defer cleanly (clearly scoped, no session-context required)

- **Consolidation backfill for `b01a9c9d`** — script template exists (`scripts/consolidate_772ac0cc.py`), ~45 min work, sized in earlier turn.
- **Full LLM cost instrumentation** — chokepoint is `lct_python_backend/services/llm_gateway.py`; persist tracker + instrument the gateway → all LLM cost captured. STT capture is separate (2-3 sites in import_bulk_pipeline + stt_ws_session).
- **PR #50 (`ci/e2e-pr-gate`)** — `d4-color-mode-smoke` decision: drop / refactor-self-provision / seed.
- **Auto-detect agenda-query browser verify** (from 2026-05-25 handover).
- **Manual selection-toolbar UX verify** (code verified, UX not).
- **Mothballed `consumption_trigger.py`** — already handled by parallel agent (`6acb99a chore(consumption): archive mothballed trigger detector`). ✓
- **69 unit-test cross-pollution** — blocks unit-test CI gate.
- **Audio fixture for nightly STT** — workflow stays manual until CC-licensed WAV is committed.

---

## Session summary

Three threads, woven:

1. **Graph saved-view canvas overlap on `b01a9c9d`** — diagnosed (all 17 ideas at identical position due to degenerate timestamps + single thread + renderer/layout size mismatch + over-aggressive auto-fit zoom), fixed in 3 atomic commits, verified live via Playwright MCP.
2. **Cost-driven STT routing investigation** — mapped that upload and live STT endpoints are already split, but the file-upload path defaults to OpenAI cloud by design. Found `provider_selection.py:286-292` makes OpenAI primary unless `local_only` set; documented three options to make uploads local-first.
3. **Tangent on offline/local migration** — verified the "RTX box" at `100.81.65.74` is actually **this machine** (Tailscale hairpin, not remote); traced the orchestrated STT path `:7777/api/transcribe` → `gpu_coordinator` → local WhisperX with Modal fallback; live-POSTed silent audio (confirmed `_backend=local_whisperx`, no Modal fired); located the kill-switches in `modal_cost_gate.py`; identified that current threshold blocks BACKGROUND/IDLE/NORMAL but **not** CRITICAL (live STT) — hence the recommendation to set `MODAL_WHISPERX_DISABLED=1`.

---

## Commits this session

All on branch `fix/graph-saved-view-overlap-and-zoom` (off `main`). **Not pushed.** Parallel agent landed 7 additional commits on the same branch (consumption, share, ADR-033, gitignore, cleanup) — branch is now scope-mixed.

- `c5e6eda` docs(agents): elevate diagnostic actions to "free evidence" — no permission needed
- `eb29f22` fix(graph-layout): spread nodes when timestamps degenerate or single-thread has no edges
- `5c9c6ed` fix(graph-canvas): match layout sizing to renderer + floor auto-fit zoom at readable threshold

Other commits on branch (NOT mine): `27e3391, f381565, fa16246, ef05ddc, b5135ad, d87e9ab, 6acb99a`.

---

## Pending threads

### Continue immediately (require this session's context)

1. **Set `MODAL_WHISPERX_DISABLED=1`** — see context-hot §1.
2. **Refresh `SHARED_AI_SERVICES.md`** — see context-hot §2. Specifically: `:8000` is not parakeet (returns a Go-default 404), `:7777` is the IndrasNet web app (not STT), `:7777/api/transcribe` IS the orchestrated STT seam (verified 2026-05-30), `100.81.65.74` is `asus-strix-scar` itself (hairpin).
3. **Branch decision** — see context-hot §3.

### Blocked / waiting

1. **Push of graph commits** — waiting on branch decision (#3 above).
2. **Browser-verify the auto-detect path** (from 2026-05-25 handover) — needs `AGENDA_QUERY_DETECTOR_ENABLED=true` + a live recording.

### Deferred (acknowledged, parked)

1. **Consolidation backfill for `b01a9c9d`** — see "Can defer cleanly."
2. **LLM + STT cost instrumentation** — gateway chokepoint identified (`llm_gateway.py`); decided as "principled but sized" — not started.
3. **Switch LCT file-upload STT path off OpenAI** — three options A/B/C documented in earlier turn. Best option is **C** (new `upload_prefer_local` setting); B is the fast version. Code lives at `lct_python_backend/services/provider_selection.py:286-310`.
4. **ADR-032 remaining parts** (Part B navigation, Part I calm animations, Part J telemetry strip, Part L `.canvas` swim-lane embed, edge-category filter UI).
5. **`SessionTranscriptOverlay.jsx` "chunks" terminology cleanup.**
6. **Orphan playwright-mcp instance cleanup** — 6+ instances were holding profile locks today; not addressed.

---

## Key context (non-obvious, don't lose)

### `100.81.65.74` is THIS machine (`asus-strix-scar`)

`tailscale status` confirms `100.81.65.74` is the local Windows host, NOT a remote box. The 0-3ms "Tailscale latency" was loopback hairpin. Memory `[[indrasnet-base-url-loopback-not-tailscale-self-ip]]` predicted exactly this. The earlier session's claim of "520ms / DERP relay" was stale or measured under different conditions. Other tailnet peers are MacBook-Air (100.84.152.26) and MacBook-Pro (100.83.228.35) — the "other agent" likely runs on a Mac.

### Verified box state (live, 2026-05-30, supersedes registry)

| Endpoint | Status | Notes |
|---|---|---|
| `:1234/v1` (LM Studio) | ✅ Up, OpenAI-compatible, 3ms | 13 chat + 6 embed models incl. qwen3.5-35b-a3b, gemma-4-31b, glm-4.7-flash, gpt-oss-20b, qwen3-coder-30b. The "suspect" model names were real. |
| `:1234/v1/audio/transcriptions` | Route exists | No STT model loaded; could serve whisper if a GGUF were loaded |
| `:7777/api/transcribe` (POST) | ✅ Orchestrated STT — VERIFIED with live POST | `proxy_transcribe` → `gpu_backends.transcribe_with_coordinator(..., context="lct_upload_transcribe")` |
| `:7777/api/transcribe/stream` (WS) | Live STT WS — code verified | priority CRITICAL via `live_stt`; `preemptable=False` |
| `:8000` | ❌ Stale Go-default 404 | NOT parakeet; the angel's `tailscale_parakeet :8000` fallback tier is dead |
| `:8001` (WhisperX direct) | ❌ Connection times out (8s) | But the orchestrator can boot it on demand via `service_orchestrator` |

### Orchestrated STT verified end-to-end

POST `silent_1s.wav` to `:7777/api/transcribe` returned:
```json
{"text":"","language":"en","duration":1.0,"model":"medium",
 "diarization":false,"_backend":"local_whisperx","_preempted":false}
```
- **`_backend: "local_whisperx"`** — the canonical local-vs-cloud canary, present in every response.
- Cold start: ~115s (WhisperX boots on demand, takes 17.2s to become healthy, then model load + inference). Warm: ~6s.
- Service auto-stops after 5-min idle (`service_orchestrator` default).
- Log line that proves orchestration fired: `GPU acquired: resource=whisperx priority=BACKGROUND context=lct_upload_transcribe wait_ms=0` (`web_server.log`).
- Modal fallback did NOT fire — verified by zero Modal mentions in the request window.

### Modal kill-switch — current state has a gap

Cost gate at `grimoire/IndrasNet/core/modal_cost_gate.py:79` (`evaluate_modal_call`):

- `MODAL_DISABLED=1` — kills all 3 services (whisperx, llm, vision).
- `MODAL_<SERVICE>_DISABLED=1` — per-service surgical kill.
- `MODAL_REQUIRE_APPROVAL_BELOW_PRIORITY=NAME` — blocks `priority > threshold_value`. Currently set to `URGENT` (value 1).

Current `.env` already has the threshold. Effect:

| Path | Priority | Blocked by threshold? |
|---|---|---|
| LCT batch upload (`/api/transcribe`) | BACKGROUND (3) | ✅ Yes — 3 > 1 |
| LCT live STT (`/api/transcribe/stream`) | CRITICAL (0) | ❌ No — 0 > 1 is false |

The threshold gate **cannot** block CRITICAL — that's the top of `GPUPriority`. To close the live-STT leak: `MODAL_WHISPERX_DISABLED=1` is the surgical fix.

When blocked, `_manager.py:198-202` raises `RuntimeError("Modal WhisperX skipped: ...")` → route returns HTTP 500. Fail-closed semantics: refuse rather than leak.

### LCT upload path bypasses IndrasNet entirely — `MODAL_WHISPERX_DISABLED=1` does NOT help LCT uploads today

**Load-bearing gotcha.** The kill-switch I set on the IndrasNet box closes the cloud-leak path *for code that calls `:7777/api/transcribe`*. But **LCT's own upload pipeline (`lct_python_backend/services/import_bulk_pipeline.py` → `services/file_transcriber.py` → `services/provider_selection.py`) does NOT route through IndrasNet at all** — it calls OpenAI directly. So LCT batch uploads continue to ship audio to OpenAI cloud regardless of the IndrasNet `.env` flag. The offline-migration is therefore more like 30% done, not 50%: only IndrasNet-mediated paths are protected.

To actually stop LCT uploads from leaking, you need the LCT routing change described below (Option B or C — Option B drafted on branch `fix/lct-upload-local-first-routing` as of 2026-05-31).

### LCT upload path currently defaults to cloud by design

`lct_python_backend/services/provider_selection.py:286-292`:
```python
if cloud_primary_allowed:  # cloud_primary_allowed = not override_provider and not local_only
    openai_candidate = fallback_candidates.get("openai_audio")
    if openai_candidate:
        add_candidate(openai_candidate)
        primary_added = True
```
Docstring: *"Import audio favors final transcript quality over time-to-first-token."* The `upload_local_first` setting is a no-op because the cloud-primary block runs first and short-circuits the local-first block at line 300.

Three options (sized in earlier turn):
- **A.** `local_only: true` config — uploads never touch cloud, no fallback.
- **B.** Code change so `upload_local_first` actually wins for uploads (~15 LOC).
- **C.** New `upload_prefer_local` setting independent of live (~25 LOC) — cleanest, matches the goal.

### LLM cost instrumentation — chokepoint identified

`lct_python_backend/services/llm_gateway.py` docstring: *"One gateway. All chat + embedding calls route through it... the single point of LLM provider integration."* Already has a `TRACE_API_CALLS` flag. **Instrumenting this one function covers all LLM cost across the 14 `_call_llm_*` sites.** The `@track_api_call` on `graph_generation.py:96,457` is the legacy partial approach.

`APICallTracker` (`instrumentation/decorators.py:18`) defaults to **no DB connection** (line 94: `_global_tracker = APICallTracker()`), so even decorated calls write to an in-memory buffer that's never persisted. Both `api_calls_log` and `usage_quotas` tables are empty (verified via psql).

### Memory updates worth knowing

The persistent memory at `~/.claude/projects/.../memory/` was modified mid-session (entry already present in the index for the GPU box stuff and IndrasNet base URL hairpin). The auto-memory now contains both. Worth a one-line addition for:
- **`indrasnet-orchestrated-stt-seam`** — `:7777/api/transcribe[/stream]` is the LCT STT endpoint into the box; bundles `gpu_coordinator` + `service_orchestrator`; reads `_backend` field for local-vs-cloud canary. (Not yet written.)
- **`modal-cost-gate-threshold-cannot-block-critical`** — `MODAL_REQUIRE_APPROVAL_BELOW_PRIORITY` blocks `priority > threshold_value`; cannot block CRITICAL (the top tier). For strict offline on live STT, must use `MODAL_<svc>_DISABLED=1`. (Not yet written.)

---

## Running processes

- **IndrasNet web server** — serving `:7777`, log at `TemporalCoordination/grimoire/IndrasNet/logs/web_server.log`. Healthy throughout the session.
- **LCT backend** — `127.0.0.1:43181` (auth-gated, returns 401 to anon).
- **LCT Vite dev server** — `127.0.0.1:43173` (IPv4-only, per memory `[[vite-must-bind-all-interfaces]]`).
- **Multiple orphan playwright-mcp Chrome processes** — kept reappearing during the session. Mass-killed several times via PowerShell `Stop-Process` filtered on `mcp-chrome-f2f9635` user-data-dir. May reappear.

---

## Files touched this session

LCT (committed):
- `AGENTS.md` — directive #2 expanded with "free evidence" sub-clause.
- `lct_app/src/components/graphLayout.js` — degenerate-timestamp guard + edge-less single-thread fix.
- `lct_app/src/components/graphLayout.test.js` — 4 new tests, 1 updated.
- `lct_app/src/components/MinimalGraph.jsx` — node sizing (250→360 / 90→280) + hoisted `MIN_READABLE_ZOOM` + tier-fit minZoom guard.

LCT (read only, for investigation):
- `lct_python_backend/services/provider_selection.py`, `file_transcriber.py`, `import_bulk_pipeline.py`, `llm_gateway.py`, `instrumentation/decorators.py`, `models/system.py`.

TemporalCoordination (read only):
- `angels/transcription_angel/config.md`, `backends/host.py`
- `grimoire/IndrasNet/core/{service_orchestrator,gpu_coordinator,modal_cost_gate,gpu_priority_policy}.py`
- `grimoire/IndrasNet/core/gpu_backends/_manager.py`
- `grimoire/IndrasNet/agents/routes/transcription.py`
- `grimoire/IndrasNet/.env`
- `docs/SHARED_AI_SERVICES.md`

Live diagnostic artifacts (untracked, intentional):
- `final-verify-pass.png`, `final-verify-overlap-and-zoom.png`, `layout-fix-verified.png`, `layout-fix-pass2.png`, `after-topics-click.png`, `overlap-{initial,topics,snapshot}.{png,yml}` — Playwright captures of the graph fixes.
- `C:/tmp/silence_1s.wav` — 1-second silent WAV used for the orchestrated STT POST.

---

## Resume instructions for the next instance

1. **Read this doc.** Then read the 2026-05-25 handover for older pending context.
2. **Most useful immediate action:** open `TemporalCoordination/grimoire/IndrasNet/.env`, add `MODAL_WHISPERX_DISABLED=1`, restart IndrasNet web server. This closes the privacy hole identified today.
3. **Second action:** update `TemporalCoordination/docs/SHARED_AI_SERVICES.md` GPU-box section with the verified table from §"Verified box state" above. The current doc is misleading on `:8000`, `:7777` purpose, and the box's identity (it's `asus-strix-scar`, not a remote box).
4. **Branch decision:** the `fix/graph-saved-view-overlap-and-zoom` branch has accumulated 7 unrelated commits from the parallel agent. Decide push-as-is vs cherry-pick before opening a PR.
5. **If user wants to continue the offline-migration thread:** the open design question is the LCT-side upload routing change (options A/B/C in `provider_selection.py`). C is recommended.

---

*Handover by Claude Opus 4.7. Doc not committed (working-tree only) — survives compaction; ride along on whatever commit the user wants.*
