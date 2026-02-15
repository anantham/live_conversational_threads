# STT Quality + Speaker Diarization Pipeline: Scope Document

**Date:** 2026-02-15
**Status:** Draft — awaiting review
**Related:** ADR-012 (Realtime Speaker Diarization Sidecar)
**Confidence:** 0.86
**Delivery:** 2 PRs (PR1 = VAD + pooling, PR2 = diarization wiring)

## Goal

Two improvements to the live STT → LLM → graph pipeline, both in `stt_http_transcriber.py`:

1. **VAD-based chunking:** Replace fixed 1.2s time slicing with voice-activity-aware boundaries so WhisperX receives coherent speech segments instead of mid-word cuts. This directly improves transcription quality.

2. **Speaker diarization wiring:** Extract speaker segments from WhisperX, thread them through the LLM, and populate `speaker_id` on graph nodes so the frontend colors nodes by speaker.

## Assumptions

- WhisperX diarization may remain intermittently off. All diarization code must degrade gracefully.
- Low-latency live UX is still priority. VAD must not add perceptible delay beyond the speech boundary itself.
- Predicted outcomes:
  - **PR1** should improve transcript coherence immediately (fewer fragments, fewer empty responses).
  - **PR2** should enable speaker-colored nodes when diarization is available.
- **Fallback:** Ship pooling only if VAD isn't stable on target machine, then revisit VAD with tuned thresholds.

## Current State

### What works
| Stage | File | Status |
|-------|------|--------|
| Session state holds `speaker_id` | `stt_session.py:17` | Default `"speaker_1"`, updatable via `session_meta` |
| Utterance/TranscriptEvent persist `speaker_id` | `stt_session.py:90,142` | Works |
| Turn synthesizer produces nodes with `speaker_id` | `turn_synthesizer.py:43` | Used for imported/viewed conversations |
| Frontend colors nodes by `speaker_id` | `MinimalGraph.jsx:45`, `graphConstants.js` | Ready, falls back to gray |

### What's broken (the gaps)
| Stage | File | Problem |
|-------|------|---------|
| Audio chunked at fixed 1.2s intervals | `stt_http_transcriber.py:111-114` | Cuts mid-word/sentence; WhisperX gets fragments |
| New HTTP connection per chunk | `stt_http_transcriber.py:178` | `httpx.AsyncClient` created/destroyed per request |
| STT HTTP transcriber extracts only text | `stt_http_transcriber.py:60-93` | Ignores speaker/segment data from WhisperX |
| Transcript text fed to LLM has no speaker labels | `transcript_processing.py:962-964` | Raw text, no `"Speaker A: ..."` prefixes |
| LLM prompt schema has no `speaker_id` field | `transcript_processing.py:24-131` | Not in GENERATE_LCT_PROMPT or LOCAL_GENERATE_LCT_PROMPT |
| Post-LLM node enrichment adds only `chunk_id` | `transcript_processing.py:982-983` | No speaker_id injection |

---

## Feature Flags

All flags are env vars with safe defaults. Existing behavior is preserved when all flags are at defaults.

| Flag | Default | Purpose |
|------|---------|---------|
| `STT_VAD_ENABLED` | `false` | Enable VAD-based chunking. When `false`, uses fixed-interval chunking (current behavior). |
| `STT_VAD_MIN_SECONDS` | `0.5` | Minimum buffer duration before VAD can trigger a flush. |
| `STT_VAD_MAX_SECONDS` | `5.0` | Safety cap — force flush even if still speaking. |
| `STT_VAD_SILENCE_MS` | `300` | Duration of silence (ms) after speech to trigger flush. |
| `STT_HTTP_POOL_ENABLED` | `true` | Reuse one `httpx.AsyncClient` per session. When `false`, creates per-request (current behavior). |

All flags read via `os.getenv()` in `stt_http_transcriber.py`. No DB, no settings UI — these are operator knobs.

---

## Architecture Decision: Diarization Approach

### Approach A: LLM-inferred speakers (simpler, less accurate)

Add `speaker_id` to the LLM prompt schema and let the LLM infer speakers from transcript text patterns. No STT changes needed.

**Pros:** Zero STT changes, works with any provider, fast to implement
**Cons:** Unreliable — LLM guesses speakers from text cues; single-mic audio has no real speaker signal; hallucination risk

### Approach B: STT-sourced diarization → LLM (more accurate, more work)

Extract speaker segments from WhisperX response, prefix transcript text with speaker labels before feeding to LLM, and add `speaker_id` to LLM output schema.

**Pros:** Real diarization data; speaker labels are grounded, not hallucinated
**Cons:** Requires WhisperX with diarization enabled; more moving parts

### Approach C: Hybrid — STT diarization when available, skip when not (recommended)

Same as B, but gracefully degrade: if the STT response has no speaker segments, feed plain text to LLM without speaker labels. Nodes produced from diarized input get `speaker_id`; others don't.

**Pros:** Best of both worlds — accurate when available, doesn't break without it
**Cons:** Same implementation cost as B

---

## Delivery: Two PRs

### PR1: VAD + Connection Pooling (`feat/stt-vad-pooling`)

Isolates risk on the core audio path. No diarization changes. Improves transcription quality for everyone.

**Layers:** 0a (VAD), 0b (pooling)

### PR2: Diarization → LLM → Graph Nodes (`feat/speaker-diarization`)

Depends on PR1 being merged. Adds speaker extraction, LLM prompt changes, and node enrichment.

**Layers:** 1 (segment extraction), 2 (accumulator prefixing), 3 (LLM prompt), 4 (fallback enrichment)

---

## Scope: PR1 — VAD + Pooling

### Layer 0a: VAD-based chunking

**File:** `lct_python_backend/services/stt_http_transcriber.py`
**Flag:** `STT_VAD_ENABLED` (default `false`)

**Problem:** Audio is currently chunked at fixed 1.2s intervals (`_min_chunk_bytes()`). This cuts mid-word and mid-sentence. Evidence from production logs:

```
transcript_preview=sense of
transcript_preview=when
transcript_preview=Gone.
transcript_preview=the shit.
```

**Solution:** Add Silero VAD to detect speech boundaries before flushing the buffer.

**Changes to `RealtimeHttpSttSession`:**
1. Add `silero-vad` dependency (runs on CPU, ~1ms per frame, ~2MB ONNX model, MIT license)
2. On init (when `STT_VAD_ENABLED=true`): load Silero VAD model. If import/load fails, log warning and fall back to fixed-interval.
3. New method `_should_flush_vad()` that runs VAD on the tail of the buffer and returns `True` when silence detected for >= `STT_VAD_SILENCE_MS`.
4. Modify `push_audio_chunk()`:
   - If VAD disabled or not loaded: current behavior (flush at `_min_chunk_bytes()`)
   - If VAD enabled: after `STT_VAD_MIN_SECONDS`, check `_should_flush_vad()` on each incoming frame. Flush on silence detection. Force-flush at `STT_VAD_MAX_SECONDS` regardless.
5. `flush()` unchanged — sends whatever is buffered on session end.

**Rollback plan:** Set `STT_VAD_ENABLED=false`. Immediately reverts to fixed-interval chunking. Connection pooling remains on independently.

### Layer 0b: HTTP connection pooling

**File:** `lct_python_backend/services/stt_http_transcriber.py`
**Flag:** `STT_HTTP_POOL_ENABLED` (default `true`)

**Problem:** Each `_transcribe_pcm()` call creates a new `httpx.AsyncClient`. For a 60-second recording, that's ~50 TCP connection setups.

**Solution:**

```python
@dataclass
class RealtimeHttpSttSession:
    ...
    _client: Optional[httpx.AsyncClient] = field(default=None, init=False)

    def __post_init__(self):
        if STT_HTTP_POOL_ENABLED:
            self._client = httpx.AsyncClient(timeout=self.timeout_seconds)

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
```

**Call site change:** `stt_api.py` calls `stt_runtime.close()` on session teardown alongside existing `stt_runtime.flush()`.

When `STT_HTTP_POOL_ENABLED=false`, falls back to per-request client (current behavior).

---

## Scope: PR2 — Diarization Wiring

### Layer 1: STT — Extract diarized segments

**File:** `lct_python_backend/services/stt_http_transcriber.py`

**Parser contract — supports both WhisperX response shapes:**

Shape A (top-level `segments`):
```json
{
  "segments": [
    {"start": 0.0, "end": 2.5, "text": "Hello there", "speaker": "SPEAKER_00"},
    {"start": 2.5, "end": 5.1, "text": "Hi, how are you", "speaker": "SPEAKER_01"}
  ]
}
```

Shape B (inline in `timestamps`):
```json
{
  "text": "Hello there. Hi, how are you",
  "timestamps": [
    {"start": 0.0, "end": 2.5, "text": "Hello there", "speaker": "SPEAKER_00"},
    {"start": 2.5, "end": 5.1, "text": "Hi, how are you", "speaker": "SPEAKER_01"}
  ],
  "speakers": ["SPEAKER_00", "SPEAKER_01"]
}
```

**Changes:**
1. New function `extract_diarized_segments(payload) -> Optional[List[dict]]`:
   - Try `payload["segments"]` first (Shape A). If entries have `"speaker"` key, return them.
   - Else try `payload["timestamps"]` (Shape B). If entries have `"speaker"` key, return them.
   - If neither has speaker data, return `None` (graceful degradation).
2. Modify `_transcribe_buffer` return to include `"segments": extract_diarized_segments(payload)` alongside `"text"`.
3. `extract_transcript_text()` unchanged — still returns plain text for providers without diarization.

### Layer 2: Accumulator — Prefix transcript with speaker labels

**File:** `lct_python_backend/services/transcript_processing.py`

**Backward-compatible signature:**
```python
async def handle_final_text(self, final_text: str, speaker_segments: Optional[List[dict]] = None) -> None:
```

The `speaker_segments=None` default means all existing call sites (non-diarized paths) remain safe with zero changes.

**Changes:**
1. `handle_final_text()` stores `(text, speaker_segments)` tuples in the accumulator instead of plain strings.
2. When building `input_text` from accumulated items:
   - If any item has `speaker_segments`: format as `"[SPEAKER_00]: Hello there\n[SPEAKER_01]: Hi, how are you"`
   - If no speaker data: join text as-is (current behavior)
3. `_process_batch()` passes the formatted text to the LLM as before.

**Call site change:** `_run_processor_final()` in `stt_api.py:427` passes `speaker_segments` from the STT result when available:
```python
await processor.handle_final_text(normalized_text, speaker_segments=result.get("segments"))
```

### Layer 3: LLM Prompt — Add `speaker_id` to node schema

**File:** `lct_python_backend/services/transcript_processing.py`

Changes to both `GENERATE_LCT_PROMPT` and `LOCAL_GENERATE_LCT_PROMPT`:
1. Add `"speaker_id"` field to the node schema: `"speaker_id": "Speaker label from transcript (e.g., 'SPEAKER_00'). Use null if not identifiable."`
2. Add instruction: "If the transcript includes speaker labels like `[SPEAKER_00]:`, assign the corresponding speaker_id to each node. If no speaker labels are present, set speaker_id to null."

### Layer 4: Post-LLM enrichment — Fallback speaker assignment

**File:** `lct_python_backend/services/transcript_processing.py`

After LLM returns nodes (line 982-983), if a node has no `speaker_id` (LLM didn't assign one or set it to null), attempt to infer from the node's `source_excerpt` or `summary` by matching against the diarized segments stored alongside the chunk text.

Best-effort fallback. Primary path is the LLM correctly copying the speaker label from the prefixed transcript.

### Layers 5-6: No changes needed

- **WebSocket:** `_send_processor_update()` sends `existing_json` as-is. If nodes have `speaker_id`, it flows automatically.
- **Frontend:** `MinimalGraph.jsx`, `graphConstants.js`, `TimelineRibbon.jsx`, `MinimalLegend.jsx` already handle `speaker_id`.

---

## Acceptance Gates

### PR1: VAD + Pooling

| Metric | Baseline (fixed 1.2s) | Target (VAD enabled) | How to measure |
|--------|----------------------|---------------------|----------------|
| **First partial latency** | ~1.2s (fixed buffer) | <= 1.5s P95 | Timestamp delta: first PCM frame → first `transcript_partial` event |
| **Final transcript latency** | ~3.5s (buffer + inference) | <= 4.0s P95 | Timestamp delta: speech end → `transcript_final` event |
| **Word-fragment rate** | ~40% of chunks produce fragments | <= 15% | Count transcripts with < 3 words or ending mid-word / total transcripts |
| **Empty response rate** | ~15% of chunks return empty | <= 5% | Count empty `transcript_preview=` / total STT requests |

Measurement method: Run a 60-second recording session with continuous speech. Log timestamps in `stt_http_transcriber.py`. Compare VAD-on vs VAD-off runs.

**PR1 gate:** word-fragment rate drops below 15% AND first partial latency stays under 1.5s P95. If latency regresses, set `STT_VAD_ENABLED=false` and ship pooling only.

### PR2: Speaker Diarization

| Metric | Baseline | Target | How to measure |
|--------|----------|--------|----------------|
| **Speaker coverage** | 0% (all nodes gray) | >= 80% of nodes have non-null `speaker_id` when diarization is on | Count nodes with `speaker_id` / total nodes in `existing_json` |
| **Speaker accuracy** | N/A | Manual spot-check: >= 75% of attributed nodes match correct speaker | Listen to audio + check assigned speaker labels for 20 random nodes |

**PR2 gate:** speaker coverage >= 80% with diarization enabled. When diarization is off, 0% coverage is expected (graceful degradation).

---

## Rollback Plan

| Scenario | Action | Effect |
|----------|--------|--------|
| VAD causes latency regression | Set `STT_VAD_ENABLED=false` | Reverts to fixed 1.2s chunking. Pooling stays on. |
| Connection pooling causes connection errors | Set `STT_HTTP_POOL_ENABLED=false` | Reverts to per-request client creation. |
| Diarization parsing crashes | Automatic — `extract_diarized_segments()` returns `None` on any error | Falls back to plain text, no speaker labels. |
| LLM ignores `speaker_id` field | No rollback needed — nodes get `speaker_id: null`, frontend shows gray | Same as current behavior. |
| Both VAD + diarization unstable | Set `STT_VAD_ENABLED=false` | Ship pooling only, revisit VAD with tuned thresholds. |

All flags are env vars — no deploy, no code change, no restart needed (read on session init).

---

## Relationship to ADR-012

ADR-012 describes a **full real-time diarization sidecar** (Diart + pyannote, dual-stream late-binding, speaker merging, correction windows). That's Phase 2-3 work.

This scope is **Phase 0** — the minimal wiring to get speaker colors working with what WhisperX already provides. It's a prerequisite: the LLM prompt and node schema need `speaker_id` regardless of whether diarization comes from WhisperX batch response or a streaming sidecar.

Forward-compatible with ADR-012:
- `speaker_id` in the node schema is permanent
- Speaker-labeled transcript input format works with any diarization source
- Graceful degradation means the streaming sidecar can be added later without breaking the existing path

---

## Verified: WhisperX Response Shape (2026-02-15)

Tested against `100.81.65.74:8001`. Health endpoint reports:
```json
{"status":"ok","model":"large-v3","stream_model":"turbo","device":"cuda","compute_type":"float16","diarization":true,"streaming":true,"backend":"whisperx"}
```

**Diarization is enabled.** Server accepts `diarize` (default `"true"`), `include_timestamps` (default `"true"`), `min_speakers`, `max_speakers` form fields.

### Response: diarization OFF (`diarize=false`)
```json
{
  "text": "The same way you measure animal intelligence",
  "language": "en",
  "duration": 5.0,
  "model": "large-v3",
  "timestamps": [
    {"start": 0.031, "end": 4.995, "text": "The same way you measure animal intelligence"}
  ],
  "speakers": null
}
```

### Response: diarization ON, single speaker (5s clip)
```json
{
  "text": "The same way you measure animal intelligence",
  "language": "en",
  "duration": 5.0,
  "model": "large-v3",
  "timestamps": [
    {"start": 0.031, "end": 4.995, "text": "The same way you measure animal intelligence", "speaker": "SPEAKER_00"}
  ],
  "speakers": [
    {"speaker": "SPEAKER_00", "start": 0.031, "end": 4.995, "text": "The same way you measure animal intelligence"}
  ]
}
```

### Response: diarization ON, multi-speaker (30s conversation)
```json
{
  "text": "You called me yesterday, I'm sorry. No, it's fine. ...",
  "language": "en",
  "duration": 30.0,
  "model": "large-v3",
  "timestamps": [
    {"start": 0.031, "end": 1.453, "text": "You called me yesterday, I'm sorry.", "speaker": "SPEAKER_02"},
    {"start": 4.035, "end": 4.636, "text": "No, it's fine.", "speaker": "SPEAKER_00"},
    {"start": 7.059, "end": 7.359, "text": "You're okay?", "speaker": "SPEAKER_02"},
    {"start": 10.262, "end": 13.746, "text": "I don't know what I'm feeling like.", "speaker": "SPEAKER_00"}
  ],
  "speakers": [
    {"speaker": "SPEAKER_02", "start": 0.031, "end": 1.453, "text": "You called me yesterday, I'm sorry."},
    {"speaker": "SPEAKER_00", "start": 4.035, "end": 4.636, "text": "No, it's fine."},
    {"speaker": "SPEAKER_02", "start": 7.059, "end": 7.359, "text": "You're okay?"},
    {"speaker": "SPEAKER_00", "start": 10.262, "end": 13.746, "text": "I don't know what I'm feeling like."}
  ]
}
```

### Key observations
- `speakers` array: `{speaker, start, end, text}` per segment
- `timestamps` also gets `speaker` field injected when diarization is on
- Speaker IDs: `SPEAKER_00`, `SPEAKER_01`, etc. — not stable across requests
- `speakers` and `timestamps` contain the same data (redundant)
- pyannote can over-segment (4 speakers detected in a 2-person conversation on short clips)
- CUDA OOM on 75s audio with `large-v3` + diarization — VAD chunking helps by sending smaller chunks
- `min_speakers`/`max_speakers` params available to constrain over-segmentation

---

## Resolved Questions

1. ~~Is WhisperX diarization enabled?~~ **Yes** — confirmed working with real multi-speaker audio.
2. ~~Cross-chunk speaker reconciliation?~~ **Deferred to ADR-012.** Accept per-chunk labels for now. Speaker IDs are not stable across chunks.
3. ~~`handle_final_text` signature change~~ **Backward-compatible:** `handle_final_text(text, speaker_segments=None)`. Existing call sites unaffected.
4. **LLM prompt token cost:** ~50-100 extra tokens per call. Negligible for Gemini Flash.
5. **Parser contract confirmed:** Use `speakers[]` array — each entry has `{speaker, start, end, text}`. When `speakers` is `null` or absent, graceful degradation (no speaker labels).

---

## Estimated Effort

| Layer | PR | Effort | Risk |
|-------|-----|--------|------|
| 0a. VAD-based chunking | PR1 | Medium (new dependency, chunking logic) | Medium — changes core audio path, gated by `STT_VAD_ENABLED` |
| 0b. Connection pooling | PR1 | Small (refactor + close method) | Low — straightforward |
| 1. STT segment extraction | PR2 | Small (new function, dual-shape parser) | Low — additive |
| 2. Accumulator speaker prefixing | PR2 | Medium (backward-compat signature, text formatting) | Medium — cross-file |
| 3. LLM prompt schema | PR2 | Small (add field + instruction) | Low — additive |
| 4. Post-LLM fallback | PR2 | Small (best-effort matching) | Low — optional |
| **Total** | | ~3-4 hours implementation | |

---

## Files Changed

### PR1
- `lct_python_backend/services/stt_http_transcriber.py` — VAD chunking, connection pooling
- `lct_python_backend/stt_api.py` — call `stt_runtime.close()` on teardown
- `lct_python_backend/requirements.txt` — add `silero-vad` (+ `onnxruntime` if not present)
- `lct_python_backend/.env.example` — document new `STT_VAD_*` and `STT_HTTP_POOL_ENABLED` flags

### PR2
- `lct_python_backend/services/stt_http_transcriber.py` — `extract_diarized_segments()`, include segments in return
- `lct_python_backend/services/transcript_processing.py` — speaker-prefixed input, `speaker_id` in prompt, fallback enrichment
- `lct_python_backend/stt_api.py` — pass speaker segments to processor

### No frontend changes in either PR
