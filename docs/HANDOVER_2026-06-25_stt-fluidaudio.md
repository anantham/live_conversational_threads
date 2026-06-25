# Handover: 2026-06-25 — STT → FluidAudio + mobile-UX session

## Session Summary
Large mobile-UX + STT-quality session. Shipped #1/#4–#8/#11 (live), #12 backend
(thread-field columns/serve/lift), #5 fullscreen, #97 picker de-noise, ADR-058 (identity),
and the headline: **replaced the hallucinating chunked-whisper live STT with a new
FluidAudio/parakeet drop-in service** (clean, ~115× realtime, no "Fuhal" loops). FluidAudio
is **LIVE** (via Tailscale-serve re-map), quota disabled, + empty-transcript→no-speech fix
(#105). Remaining: FluidAudio supervision (launchd-ANE wall → nohup), real whisper fallback,
provider-label setting, diarization (#2), topic-stack rail (#12), identity tier (#13/#14),
cost dashboard (#10).

## ⚠️ LIVE OPERATIONAL STATE — read FIRST (NONE of this is in any git diff)
- **Live STT = FluidAudio (parakeet), NOT whisper.** Backend (Asus `:43181`) calls STT at `https://adityas-macbook-pro.tail4741ad.ts.net:5443`.
- **Tailscale serve (M5 = this Mac):** `:5443 → 127.0.0.1:5096` (FluidAudio) **and** `:5444 → 127.0.0.1:5096` (also FluidAudio now — was *meant* to be whisper fallback). Real whisper = `:5095` (localhost only).
- **FluidAudio runs as a nohup process** (NOT launchd — CoreML/ANE won't init in a launchd bg context). PID `/tmp/fa-stt.pid`. Binary `lct_python_backend/local_stt/fluidaudio_stt/.build/release/fluidaudio-stt`.
  - **Restart:** `( cd lct_python_backend/local_stt/fluidaudio_stt && env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" PATH="/opt/homebrew/bin:/usr/bin:/bin" nohup .build/release/fluidaudio-stt > /tmp/fa-stt.log 2>&1 & )` — health `curl localhost:5096/health`.
- **whisper (mlx-stt)** under launchd `com.aditya.mlx-stt` on `:5095` (untouched, real fallback engine).
- **Asus `.env` keys set this session:** `FREE_STT_DAILY_MINUTES=999999`, `BYOK_REQUIRED_AFTER_FREE=false`, `STT_LOCAL_ONLY=false`, `DEFAULT_STT_PROVIDER=parakeet`, `DEFAULT_STT_PARAKEET_HTTP_URL=…:5443`, `DEFAULT_STT_WHISPER_HTTP_URL=…:5444`.
- **Dead launchd plist:** `~/Library/LaunchAgents/com.aditya.fluidaudio-stt.plist` (installed, booted out — hangs, ANE wall).
- **Instant revert STT→whisper:** `tailscale serve --bg --https=5443 http://127.0.0.1:5095`.
- **Backend restart (Asus):** stop `:43181` + `logs/start_lct_backend.ps1` (runbook in AGENTS.md).

## Commits / PRs This Session (all merged to `main`)
#91/#92 mobile-UX; #94 handover+worklog; #96 (#6/#7/#8); #97 picker de-noise (#4); #98 ADR-058;
#99 (#5 fullscreen); #100 (#11 state-map + #10 cost-scope docs); #101 (#12 thread-field
columns+serve+lift); #102 backend-restart runbook; #103 #101 migration-head fix; #104 (#2
speaker_patch wiring); #105 (#15 empty-transcript→no-speech).
**UNCOMMITTED — the FluidAudio Swift service** (`lct_python_backend/local_stt/fluidaudio_stt/`, **0 files in git**, on disk + Syncthing only). ← **commit source (Sources/, Package.swift, Package.resolved, README.md); gitignore `.build/` + the `parakeet-tdt-0.6b-v3-coreml` symlink dir.**

## Verbatim user quotes (key arcs)
- *"isnt this a lot of band aids rather than principled fixes"* — drove the pivot from whisper output-filtering to the FluidAudio engine swap.
- *"all that was incorrect the people were speaking fluent english only … run on a proper local model … compare with the nodes and the transcript"* — corrected my multilingual argument (built on whisper hallucinations) + authorized the empirical comparison.
- *"run experiments we have audio we cna try stuff and empirically see what helps"*
- *"does fluid audio handle chunks as audio streams in"* / *"ok cool any blocker? wire it in?"*
- *"dont break prod I am recording an important conversation"* — hands-off-prod-during-recording (recurring).
- *"why this blocker when I am not using openai key the recordings is over please do the fixes"* — quota + empty-transcript + fallback fixes.
- *"let's do the clean fix now. Let's do a also like zoom out and what are all the pending threats?"*
- *"why can't you switch the setting?"* — re the client-side STT provider setting.

## ADRs
- **ADR-058: Human-Gated Identity** (#98) — voice→person + contact merge/split/confirm; scoped, NOT built.

## Pending Threads
### Continue Immediately
1. **COMMIT the FluidAudio service** — `fluidaudio_stt/` not in git. Source only; gitignore `.build/` + the `-coreml` symlink. Durability risk.
2. **Provider label + real fallback ("clean fix")** — frontend saves `provider=whisper` **client-side** (localStorage; code default already `parakeet` at `sttUtils.js:22`). Fix: user flips STT-settings dropdown→Parakeet, OR force `provider=parakeet` backend-side. THEN re-map `:5444 → :5095` (real whisper) so fallback + multilingual are real (both ports → FluidAudio now). Backend whisper-fallback only activates when `selected_provider != "whisper"` AND `local_only=false` AND whisper URL non-local — `stt_live_provider_selection.py:141-162`.
3. **FluidAudio supervision** — nohup, no auto-restart (launchd-ANE wall). Needs a user-session launcher (login item / Aqua). Dies/reboot → STT down until manual restart.
4. **#2 diarization → speaker labels/colors** — fetch FluidAudio diarizer models (Embedding/FBank/PldaRho/Segmentation `.mlmodelc` + `plda-parameters.json`) + add a DiarizerManager mode. `speaker_patch` wiring (#104) deployed, waiting on diarized data. Also yields #13's voice embedding.

### Deferred (task list + ADR-058 + task #15 hold detail)
- **#12 topic-stack rail** — push/pop a→b→c UI; backend already lights up existing `graphLayout` swim-lanes.
- **#12 re-extraction** — old convos have garbage graphs (hallucinated transcripts); re-process.
- **#13 voice identity + #14 contact curation** — ADR-058, not built.
- **#10 cost dashboard** — `docs/cost-dashboard-counterfactual-scoping.md`, not built.
- **#4** picker de-noise (#97) — merged; Asus pulled main during env restarts (verify live).

### Carried forward from prior handovers (pre-session, still live)
- **ADR-038 privacy boundary** — design done, GO-gate No-Go; redesign at `docs/plans/2026-06-20-adr-038-enforcement-redesign.md`.
- **P1b IndrasNet PULL/PUSH** (cross-repo, `TemporalCoordination#17`); **P2** `lct_pipeline/` package + CI lint.
- ADR-030 conversation_pipeline cutover · ADR-027 DB-canonical prompts.

### Explicit decisions NOT to do
- Don't band-aid whisper output (params/VAD/repeat-collapse) — the fix was the FluidAudio engine swap.
- Don't run FluidAudio under a launchd **background** agent — ANE won't init there.

## Key Context
- **FluidAudio** = local CoreML/ANE engine (parakeet-tdt-0.6b-v3 ASR + VAD + diarization). ASR models at `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3/` (present); diarization models NOT downloaded. Service uses a `parakeet-tdt-0.6b-v3-coreml/` **symlink** dir — see `fluidaudio_stt/README.md` for the `-coreml` path trick + Swift-6 `.v5` lang-mode fix + Swifter Content-Length fix.
- **Empirical proof (#15):** conv `a941a314` (47 min) — chunked-whisper = Fuhal×74/"problem"×223 garbage; FluidAudio = 7575 words clean, 0 hallucinations, ~115× realtime. Clean transcript `/tmp/a941_full_clean.txt`. `spokenly` CLI (also FluidAudio) = easy batch tool.
- **M5 IS this Mac** (`adityas-macbook-pro`, TS `100.83.228.35`); backend = Asus (`asus-strix-scar`). SSH: `ssh adity@asus-strix-scar "powershell -NoProfile -EncodedCommand <b64-UTF16LE>"`; set `$ProgressPreference='SilentlyContinue'`.
- **AFFORDANCES:** `~/Documents/Ongoing Local/AFFORDANCES.md`.

## Operator Cleanup (manual)
- Flip STT provider **Whisper → Parakeet** in the app's STT-settings UI (client-side) → correct label + enables real whisper fallback (after `:5444`→`:5095` re-map).
- Optional: `launchctl bootout gui/$(id -u)/com.aditya.fluidaudio-stt 2>/dev/null; rm ~/Library/LaunchAgents/com.aditya.fluidaudio-stt.plist`.

## Running Processes
- **FluidAudio STT** — nohup, `:5096`, pid `/tmp/fa-stt.pid` — THE live STT engine.
- **whisper mlx-stt** — launchd `com.aditya.mlx-stt`, `:5095` — fallback.
- **LCT backend** — Asus `:43181`.

## Calibration moments
| Moment | Lesson |
|---|---|
| Argued a multilingual-ASR concern from "mota patla"/"Fuh alla" — whisper HALLUCINATIONS, not real speech | Don't reason about the input from a broken transcriber's output; get ground truth first |
| Band-aided whisper (VAD/params) 2 rounds before user said "isn't this band-aids" | Stacking output-filters on a model → step back; the input/engine is often the fix |
| FluidAudio launchd agent hangs (CoreML/ANE won't init in launchd bg) | ANE needs a user/Aqua session; MLX-Metal works under launchd, CoreML/ANE doesn't |
| `.env` change re-broke routing — frontend forces `provider=whisper` (overrides backend default) | Trace provider-selection end-to-end (frontend session_meta wins) before re-pointing URLs |
| Several live-backend changes hit the auto-mode classifier gate | Live `.env`/migration/restart + persistent launchd installs need explicit per-action user OK |

---
*Handover by Claude at ~90% context. Next instance: read the LIVE OPERATIONAL STATE block before touching STT.*
