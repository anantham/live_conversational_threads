# HANDOVER 2026-06-24 — Mobile UX critique backlog + edge-STT shelved

Live mobile testing of `threads.adityaarpitha.com` (the deployed `lct_app`) surfaced a
batch of UX + STT-quality issues plus an edge-STT validation attempt. This logs **all**
of it so work resumes without starting from 0. Items below were tracked as session
tasks #1–#12.

Deploy mechanics for any of this (git auto-deploy `main`, `rootDirectory=lct_app`,
repo-root CLI fallback, domain-is-a-production-alias) are documented in `AGENTS.md` →
PROJECT-LOCAL → "Deployment (Vercel)".

---

## DECISION: edge STT is SHELVED (relay is good enough)

Phase-1 edge STT — the client POSTs audio **straight to the M5**, bypassing the
Asus relay (ADR-056; PRs #89 code, #90 CORS) — is **built + deployed behind `?edge=1`**
but was **never confirmed to actually route phone→M5**. Every test showed **100% relay**:
the M5 access log (`~/Library/Logs/mlx-stt.out.log`) had all transcribe POSTs coming
from the Asus `100.81.65.74`, and **zero** from `127.0.0.1` (which is what a
Tailscale-Serve-proxied edge hit looks like, since Serve terminates TLS on the M5 and
proxies from localhost).

- **Endpoint is healthy** (not the problem): `/health` loads from the phone at
  `https://adityas-macbook-pro.tail4741ad.ts.net:5443` → `127.0.0.1:5095`; CORS
  preflight returns 200 `acao:*`; health JSON reports `diarization: available`, model
  `mlx-community/whisper-large-v3-turbo`, `mlx-metal-ane`.
- **Most likely blocker:** `?edge=1` was set on the **home** URL, but the SPA drops the
  query param on client-side navigation to the recording screen, and incognito has no
  `localStorage` to bridge it → `readEdgeConfig` sees no flag at `NewConversation` mount
  → `edgeConfig.enabled=false` → relay. (A silent runtime fallback via `onFallback`
  would look identical from the server side, so this isn't 100% confirmed.)
- **Why shelved:** the user reports relay latency is acceptable in practice ("quite
  real-time, not that bad"). Edge was a latency optimization for a latency that's now
  tolerable.
- **Resume (only if relay latency becomes a problem):**
  1. Make `readEdgeConfig` run at the app root and persist, OR carry `?edge=1` through
     navigation, so the flag reaches the recording screen.
  2. Add a visible on-screen **edge/relay indicator** (doubles as telemetry — see #10).
  3. Re-test: incognito → `?edge=1` → record ~10s → watch the M5 log for `127.0.0.1`
     POSTs (= edge) vs `100.81.65.74` (= relay). Server-side tagging of edge-vs-relay
     would make this instant (telemetry gap, #10).

---

## Backlog (open, priority order)

| # | Item | State |
|---|------|-------|
| 1 | STT repeating-word hallucination ("thank you"/"excuse me" loop) | root cause found |
| 12 | Thread/tangent detection too aggressive (new thread every few seconds) | needs investigation |
| 2 | Show speaker labels + color transcript text per speaker (`aditya:`/`bhishma:`) | depends on #3 |
| 3 | Diarization "not running" (FluidAudio "planned") | narrowed (see findings) |
| 5 | Full-screen transcript: no exit/collapse + graph buttons block the subtitle view | partly a self-regression |
| 6 | Useless "audio download is ready" toast | source identified |
| 7 | Upload button is a different color — intentional accent or accident? | trivial check |
| 8 | Node-select doesn't seek audio to the node timestamp (mobile → plays from 0) | causes found |
| 4 | Contacts are dummy placeholders, not pulled from IndrasNet | see `docs/INDRASNET_INTEGRATION.md` |
| 10 | Cost dashboard reads 0/0/0 — build real usage + counterfactual cloud-vs-local savings | see `docs/ROADMAP_INSTRUMENTATION_METRICS.md` |
| 11 | Author a UI state map (statechart + affordance matrix) for the live-session screen | new |
| 9 | Validate edge STT (`?edge=1` phone-direct) | **SHELVED** (see decision above) |

---

## Findings already made (do NOT re-derive)

- **#1 STT hallucination.** `lct_python_backend/local_stt/server.py:~284` calls
  `mlx_whisper.transcribe(tmp_path, **kwargs)` where `kwargs` sets **only** `language`
  and `word_timestamps` — **no anti-hallucination params**. So it runs Whisper defaults:
  `condition_on_previous_text=True` (the cause of the repeat-loop attractor) and no
  VAD / `no_speech_threshold` (the cause of "thank you"/"you" on silence + short edge
  chunks). Model is `whisper-large-v3-turbo`. **Fix:** set
  `condition_on_previous_text=False`, `no_speech_threshold`, `compression_ratio_threshold`,
  `logprob_threshold`, `temperature=0`, `hallucination_silence_threshold` (verify each is
  supported by the installed `mlx-whisper`); consider a VAD pre-filter. cf
  `docs/STT_BENCHMARK_2026-06-04.md`.
- **#12 threads too aggressive.** Got 4–6 threads from a few seconds of speech; a new
  thread spawns within a few words. Desired heuristic: a new tangent should need ~minutes
  of drift (soft, not a hard cap). **TODO:** find where `branches` are computed (backend
  thread/branch detection — the LLM prompt and/or clustering heuristic feeding
  `TranscriptBranchRail`), surface the prompt, add temporal hysteresis / minimum-duration
  before splitting.
- **#3 diarization.** The M5 `/health` reports `"diarization":"available"` → the server
  **can** diarize (ECAPA-embeddings path in `server.py`). The gap is the **client not
  requesting it** (`diarize=true`); the settings screen's "FluidAudio (planned) — not
  running" refers to a separate planned diarizer, not the working Whisper-based path.
  Smaller fix than feared — unblocks #2.
- **#2 speaker labels.** `SessionTranscriptOverlay` already has `colorForSpeaker()`; the
  gap is the speaker field arriving (needs #3) + rendering it as a colored **name** prefix
  (`aditya:` / `bhishma:`). Speaker naming/colors already live in `MinimalLegend`.
- **#5 fullscreen transcript.** Partly a **self-regression** from this session: the
  fullscreen toggle (transcript) + bumping Center/Display/Legend to `z-40` left those
  graph affordances floating over the subtitle view with no clear exit-fullscreen. Fix:
  add a reachable collapse/exit control in the transcript view + hide graph chrome while
  the transcript is expanded/fullscreen.
- **#6 audio toast.** `NewConversation.jsx` audio-recovery handler `setMessage("Recovered
  audio is ready to download." / "Recovered available audio for this draft.")` — drop or
  demote.
- **#8 node-select audio seek (mobile).** `NodeDetail.jsx` `<audio preload="metadata">`
  is ignored by mobile browsers (treated as `none`) → `readyState` stays 0 → seek defers
  to `pendingSeekRef`, which mobile applies unreliably (media not seekable yet when
  `loadedmetadata` fires on user-play). ALSO the seek reads only
  `safeNode.timestamp_start ?? start_time`, whereas `TimelineRibbon` reads
  `timestamp_start ?? start_time ?? timestamp ?? time ?? start ?? metadata.*`. **Fix:**
  broaden NodeDetail's extraction to match, and make the deferred seek robust (retry on
  `loadedmetadata`/`loadeddata`/`canplay` until `currentTime` sticks; apply on `play`).

---

## What shipped in this session (already on `main`, live)

- Discard-draft unstuck + status-noise cleanup (PR #91): the transient toast no longer
  resurrects the local draft; "STT is slow" demoted from a banner to a health-pulse
  color; redundant status text removed from the transcript card.
- Timeline-click centers the node without opening the drawer; full-screen transcript
  toggle; threads/tangents rail collapsible (default collapsed); Colors folded into
  Legend; Legend raised above the transcript (PR #91 + #92).
- Back button no longer covers the zoom/tier HUD (PR #92).
- GitHub auto-deploy connected (`main`→prod), `rootDirectory=lct_app` fixed, deploy
  mechanics documented in `AGENTS.md` (PR #93). ADR-056 recalibration merged (#88).
