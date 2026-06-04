# STT Orchestration Overhead — Architecture RCA

**Date:** 2026-06-04
**Status:** RCA only (no fix applied)
**Question:** Why is the IndrasNet-orchestrated STT path ~8x slower than calling WhisperX directly, and can the GPU-contention coordination be preserved while removing the accidental overhead?

---

## TL;DR

The 8x is **not** the coordination tax. It is an **impedance mismatch**: LCT was built to drive *stateless cloud chunk-APIs* (OpenAI/OpenRouter, 25 MB upload caps, no shared GPU), and it points that same chunking machinery at IndrasNet's coordinator, which was designed for **per-FILE batch jobs** (like `transcription_angel` / `media_library_agent`).

For a 41-min file, LCT:
- slices it into **~85 × 30s chunks** (`DEFAULT_CHUNK_DURATION_S = 30`),
- fires **~85 separate `POST :7777/api/transcribe`** HTTP calls,
- each call does its **own** `gpu_coordinator.acquire()` + release,
- each call crosses the **Windows→WSL** network hop to `localhost:8001`,
- each call runs **full pyannote diarization on its own 30s slice** (`diarize` defaults to `"true"`), and
- trips the WhisperX server's **`_RESET_THRESHOLD = 20`** model-unload ~4 times mid-file, each forcing a cold model reload.

The OTHER consumer (`media_library_agent.transcribe_audio`) sends the **whole file in ONE call** → one acquire, one WSL hop, one diarization pass, zero mid-file resets. That is the gold-standard comparison and is the recommended shape for LCT.

**The coordinator already does per-file acquire correctly. LCT's chunking is what defeats it.**

---

## The two call shapes, side by side

### Consumer A — `transcription_angel` / `media_library_agent` (the RIGHT shape)
`grimoire/IndrasNet/agents/media_library_agent.py:326`
```python
result = await gpu_backends.transcribe_with_coordinator(
    audio_path=str(audio_path),      # <-- WHOLE FILE
    language="en", diarize=True,
    priority=3, context=f"media_library_...",
    coordinator_timeout=60.0,
)
```
→ **1 acquire, 1 WSL HTTP, 1 diarization, server-side chunking only.**

### Consumer B — LCT import (the PATHOLOGICAL shape)
LCT splits the file, then loops one HTTP call per 30s chunk:
- `lct_python_backend/services/audio_transcriber.py:403` — `_split_audio_to_chunks(...)`
- `audio_transcriber.py:421-462` — `for idx, chunk in chunks: await transcribe_audio_file(chunk, ...)` (one HTTP POST per chunk)
- each `transcribe_audio_file` → `transcribe_audio_file_detailed` → `httpx.post(target_url, ...)` at `audio_transcriber.py:110-111`, where `target_url` is IndrasNet `:7777/api/transcribe`.

→ **N acquires, N WSL HTTPs, N diarizations, N/20 mid-file model resets.**

The IndrasNet endpoint is per-request agnostic — it can't tell that 85 calls belong to one file:
`grimoire/IndrasNet/agents/routes/transcription.py:100-140` (one `transcribe_with_coordinator` per POST).

---

## (a) Overhead decomposition table

Estimates are order-of-magnitude attributions for a 41-min file at ~85 chunks on the RTX 3080 16GB. The measured envelope is DIRECT ≈ 10x realtime (≈4-5 min) vs ORCHESTRATED ≈ 1x realtime (≈39 min). The table apportions the ~34-min gap.

| # | Cause | file:line | Est. cost | Necessary or Accidental |
|---|-------|-----------|-----------|--------------------------|
| 1 | **Per-chunk diarization** — each 30s chunk runs full pyannote independently; direct bench diarized ONCE over the whole file | IndrasNet `transcription.py:104` (`diarize=Form("true")`) → `whisperx_server.py:523-552` (`get_diarize_model()` + `diarize_model(...)` per request); LCT never overrides diarize in `audio_transcriber.py:98-105` | **Very large.** Diarization (model load + inference) repeated ~85× instead of 1×. Direct bench: +5.0s once. Orchestrated: pyannote setup+run paid every chunk. Plausibly the single biggest contributor. | **ACCIDENTAL** (and semantically wrong — speaker IDs are not consistent across independently-diarized 30s windows) |
| 2 | **Mid-file model resets** — server unloads ALL models (whisper + pyannote + align + embedding) every 20 transcriptions; counter is per-REQUEST | `whisperx_server.py:124-125` (`_RESET_THRESHOLD = 20`), `:435-437` (increment + `reset_all_models()`), `:142-154` (drops every model ref + `empty_cache`), lazy reload at `:177-187`, `:190-201` | **Large.** ~85 chunks ÷ 20 ≈ **4 full cold reloads** of large-v3 + pyannote mid-file. Cold load measured ~80-115s each (see `_whisperx.py:187` comment). One whole-file call trips this **0** times. | **ACCIDENTAL** (artifact of counting chunks as transcriptions; a whole-file call = 1 transcription) |
| 3 | **Per-chunk coordinator acquire/release** — full enqueue → condition-wait → preempt-check → release cycle, ~85× | `_manager.py:138-143` (`acquire` per call), `gpu_coordinator.py:167-238` (`acquire`/`_enqueue`/`_wait_for_resource`/`_release`), endpoint `transcription.py:132-139` | **Small-moderate** when GPU is idle (lock + condition wakeups, ms-scale each); can balloon if any competing consumer interleaves between chunks and re-queues LCT behind them. Plus `service_orchestrator.ensure_running()` is invoked on EVERY acquire (`gpu_coordinator.py:196-204`). | **MOSTLY ACCIDENTAL** — the *serialization guarantee* is necessary, but doing it 85× per file instead of 1× is not. One acquire/file preserves the guarantee. |
| 4 | **Windows→WSL hop ×85** — each chunk POST crosses native-Windows → WSL2 `localhost:8001`; on failure falls back to spawning `wsl ... curl` subprocess | `_whisperx.py:203-271` (`_transcribe_http`), `:273-352` (`_transcribe_via_wsl` curl-in-WSL fallback), base URL `_constants.py:11` (`http://localhost:8001`) | **Moderate + instability.** TLS/connect setup + large multipart body marshalled across the WSL NAT/mirrored-net boundary 85×. This is the source of the chunk-3 `ConnectError` wedging (WSL2 localhost/IPv6 hairpin); the curl fallback spawns a `wsl` subprocess + `sleep 3600` keepalive per failure (`:318-324`). | **ACCIDENTAL on two axes:** (i) crossing the hop 85× instead of 1×; (ii) running WhisperX in WSL at all (native-Windows whisperlocal eliminates the hop entirely — that's the DIRECT bench's environment). |
| 5 | **Per-chunk client setup / re-upload** — fresh `httpx.AsyncClient` per chunk (no pooling on import path); chunk WAVs exported to disk via pydub then re-read | LCT new client per call `audio_transcriber.py:110`; chunk export `audio_transcriber.py:209-212`; IndrasNet re-buffers to a temp file per request `transcription.py:118-121` | **Small.** Connection/TLS setup, pydub export, double temp-file write, double file read — ×85. | **ACCIDENTAL** |
| 6 | **Coordinator `acquire` GUARANTEE itself** (serialize GPU across LCT/angel/beeper/LM Studio, priority + preemption + LM-Studio VRAM handoff) | `gpu_coordinator.py:41-48` (priorities), `:120-128` (preemption rules), `service_orchestrator.py:529-542` (`VRAM_UNLOAD_BEFORE_GPU` handoff), `_manager.py:194-207` (Modal overflow) | **Essentially zero** marginal cost when amortized over a whole file. The lock/queue is a thin policy layer (~300 lines, no GPU work). | **NECESSARY — this is the whole point and must be preserved.** |

**Coordination tax vs overhead tax:** rows 1, 2, 4, 5 are pure accidental overhead (≈ the entire 8x). Row 3 is *mostly* accidental — only the "×85" multiplier is, not the guarantee. Row 6 (the actual contention coordination) costs ~nothing per file. **The 8x is not fundamental to coordination.**

---

## (b) Why chunked-HTTP-through-WSL is pathological for THIS workload

1. **It re-implements, badly, work the server already does well.** `whisperx_server.py:454-483` already chunks files >`MAX_CHUNK_SECONDS` (600s/10min) internally, on-GPU, with the model **resident** and `empty_cache()` between chunks (`:474-477`) — no network, no re-acquire, no per-chunk diarization. LCT's external 30s chunking is finer-grained, network-bound, and **defeats** the server's own efficient path. The server is happiest with one whole-file POST.

2. **30s chunks cross the diarization-economics threshold the wrong way.** pyannote has a fixed per-call setup cost and produces speaker labels that are only meaningful **within** the audio it sees. Diarizing 85 × 30s windows pays that setup 85× AND yields 85 disjoint `SPEAKER_00/01` namespaces that don't stitch across chunk boundaries. The direct bench diarized once → one coherent speaker map, +5.0s total.

3. **It turns one model lifecycle into ~85.** The server's `_RESET_THRESHOLD = 20` (`whisperx_server.py:125`) is a per-*transcription* leak mitigation that assumes "transcription = a file." With 85 chunks it fires mid-file ~4×, each a cold large-v3 + pyannote reload (~80-115s, `_whisperx.py:184-194`). The outer `WhisperXBackend._restart_threshold` was *already raised 20→200* (`_whisperx.py:30-38`) specifically because "LCT slices a 41-min upload into ~85 chunks" was tripping the process-restart mid-file — a band-aid that treats the symptom (chunk count) not the cause (chunking).

4. **It multiplies the least-reliable link by 85.** The Windows→WSL2 `localhost` hop is the known-flaky boundary (mirrored-mode/IPv6 hairpin — see the curl-in-WSL fallback that exists *only* to dodge it, `_whisperx.py:273-293`). One file = one chance to hit a `ConnectError`; 85 chunks = 85 chances. With `STT_CHUNK_MAX_RETRIES = 4` (`transcription_utils.py:105`) each transient adds backoff seconds, and a chunk that exhausts retries aborts the whole import. This is the "chunk-3 ConnectError / restart cascade" wedging.

5. **It serializes latency it can't hide.** Even when nothing fails, the wall-clock is `85 × (acquire + connect + upload + [maybe reload] + transcribe30s + diarize30s + release + WSL marshalling)`. The fixed per-chunk overheads (rows 2-5) don't shrink with GPU speed, so a faster GPU barely helps — which is exactly why orchestrated sits at ~1x realtime while the same GPU does 8-10x realtime in-process.

---

## (c) Recommendation — preserve coordination, delete the accidental 8x

The fix is to make LCT's IndrasNet path look like Consumer A (whole-file), and let the coordinator + server do what they're already good at.

### Primary: LCT sends ONE whole-file call per import to the coordinator
- For the `backend_http` transport that targets IndrasNet, **bypass `_split_audio_to_chunks` / `transcribe_audio_chunked` / `transcribe_audio_segmented`** and POST the whole file once (the `len(chunks) <= 1` branch at `audio_transcriber.py:405-416` already does exactly this — route IndrasNet through it unconditionally).
- This yields: **1** `gpu_coordinator.acquire` per file (priority/preemption/Modal-overflow/LM-Studio-VRAM-handoff all intact — rows 6 preserved), **1** WSL hop, **1** diarization pass, **0** mid-file resets.
- The server already chunks internally for OOM safety (`whisperx_server.py:454`), so large files stay safe without LCT's help.
- **Caveats to handle, not ignore:**
  - *Progressive UX / checkpoints:* the chunk loop currently powers per-chunk SSE progress + resume checkpoints (`import_bulk_pipeline.py:422-508`). A whole-file call loses granular progress. Mitigation: keep the **silence-based segmented** path (`transcribe_audio_segmented`, 2-8 min segments via `DEFAULT_MAX_SEGMENT_MS = 480000`) as the progressive unit, but make each *segment* one whole-file coordinator call instead of 16 × 30s sub-chunks. That cuts ~85 calls → ~5-10, restoring most of the win while keeping progress/resume.
  - *Diarization correctness:* a whole-file (or whole-segment) diarization gives coherent speaker labels — strictly better than today's per-30s labels.
  - *Client timeout:* a whole 41-min file needs a long read timeout; IndrasNet's backend already uses `total=900s` (`_whisperx.py:218-222`). LCT's import timeout default is 120s (`file_transcriber.py:283`) — must be raised for the whole-file path.

### Secondary (independent, compounding): move WhisperX to native Windows
- The DIRECT bench (8-10x realtime) ran in the `whisperlocal` conda env **on Windows, in-process** — no WSL hop. Running the WhisperX *server* natively on Windows (or pointing LCT/coordinator at a native-Windows whisperx HTTP server) deletes row 4's instability entirely and removes the curl-in-WSL fallback machinery.
- Coordination is unaffected: the coordinator doesn't care whether the backend is WSL or native; only `WHISPERX_BASE_URL` (`_constants.py:11`) changes.

### Tertiary (cheap insurance): keep the server warm + stop counting chunks as transcriptions
- With whole-file calls, `_RESET_THRESHOLD = 20` becomes a non-issue (1 file = 1 count). If chunking is ever retained, the reset counter should key off *files*, not requests, or the threshold raised commensurately — the outer process-restart was already band-aided 20→200 for this exact reason (`_whisperx.py:30-38`).
- The orchestrator's idle auto-stop (`service_orchestrator.py:72-79`, whisperx 300s) is fine for whole-file jobs (one cold start per import, amortized) but is a tax if imports arrive in bursts — a keep-warm pin (like `KEEP_WARM_MODELS`, `service_orchestrator.py:86-93`) during an active import batch would remove repeated cold starts.

### What NOT to do
- Do **not** remove the coordinator or have LCT hit `localhost:8001` directly. That would reintroduce GPU contention with `transcription_angel`, beeper/meet workers, and LM Studio on the single 16GB card — the exact problem the coordinator exists to solve (row 6). The coordination is necessary; only the per-chunk *granularity* is the bug.

---

## Evidence index (file:line)

**LCT (chunking driver):**
- 30s chunk size: `lct_python_backend/services/transcription_utils.py:99` (`DEFAULT_CHUNK_DURATION_S = 30`), overlap `:100`
- Split to chunks on disk: `audio_transcriber.py:187-226`
- Per-chunk HTTP loop: `audio_transcriber.py:421-462`; single-file fast path `:405-416`
- Per-chunk HTTP POST (new client each call): `audio_transcriber.py:107-111`; no `diarize` field sent `:98-105`
- Segmented (2-8 min) → calls chunked per segment: `audio_transcriber.py:559-572`; max segment `transcription_utils.py:110` (`480000` ms)
- Import picks segmented for files >10 MB and `backend_http` transport: `import_bulk_pipeline.py:548-559`; threshold `import_bulk_helpers.py:24-26`
- Retry/backoff per chunk: `transcription_utils.py:105` (`STT_CHUNK_MAX_RETRIES = 4`), `:106`
- Import client timeout default 120s: `file_transcriber.py:283`

**IndrasNet (coordinator + server):**
- `/api/transcribe` = 1 coordinator call per POST, `diarize` defaults true: `agents/routes/transcription.py:100-140` (`:104`, `:132-139`)
- Coordinator acquire/queue/release: `core/gpu_coordinator.py:167-238`, `:240-277`, `:346-417`, `:436-465`
- Priorities + preemption (the necessary guarantee): `gpu_coordinator.py:41-48`, `:120-128`
- `transcribe_with_coordinator` (1 acquire wraps 1 whole-file transcribe): `core/gpu_backends/_manager.py:103-207`
- WSL HTTP + curl-in-WSL fallback: `core/gpu_backends/_whisperx.py:203-352`; base URL `core/gpu_backends/_constants.py:11`
- Outer process-restart raised 20→200 *because of* LCT's 85-chunk slicing: `_whisperx.py:30-38`
- Cold-load ~80-115s: `_whisperx.py:184-194`
- Per-request model reset every 20 transcriptions (unloads whisper+pyannote+align+embedding): `services/transcription/whisperx_server.py:124-125`, `:128-161`, `:435-437`
- Server-side internal chunking for >10min files (the efficient path LCT defeats): `whisperx_server.py:454-483`
- Per-request diarization: `whisperx_server.py:523-552`
- Idle auto-stop (whisperx 300s) + keep-warm precedent: `core/service_orchestrator.py:72-79`, `:86-93`, `:529-542`

**The gold comparison:**
- Whole-file consumer: `agents/media_library_agent.py:315-342` (one `transcribe_with_coordinator(audio_path=whole_file)`).
