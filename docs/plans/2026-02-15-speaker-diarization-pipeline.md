# Speaker Diarization → Graph Node Coloring: Scope Document

**Date:** 2026-02-15
**Status:** Draft — awaiting review
**Related:** ADR-012 (Realtime Speaker Diarization Sidecar)

## Goal

Wire speaker identity from STT → LLM → graph nodes so MinimalGraph colors nodes by speaker. The frontend is already ready (`speakerColorMap` lookup in `MinimalGraph.jsx`); the gap is entirely backend.

## Current State

### What works
| Stage | File | Status |
|-------|------|--------|
| Session state holds `speaker_id` | `stt_session.py:17` | Default `"speaker_1"`, updatable via `session_meta` |
| Utterance/TranscriptEvent persist `speaker_id` | `stt_session.py:90,142` | Works |
| Turn synthesizer produces nodes with `speaker_id` | `turn_synthesizer.py:43` | Used for imported/viewed conversations |
| Frontend colors nodes by `speaker_id` | `MinimalGraph.jsx:45`, `graphConstants.js` | Ready, falls back to gray |

### What's broken (the gap)
| Stage | File | Problem |
|-------|------|---------|
| STT HTTP transcriber extracts only text | `stt_http_transcriber.py:60-93` | Ignores speaker/segment data from WhisperX |
| Transcript text fed to LLM has no speaker labels | `transcript_processing.py:962-964` | Raw text, no `"Speaker A: ..."` prefixes |
| LLM prompt schema has no `speaker_id` field | `transcript_processing.py:24-131` | Not in GENERATE_LCT_PROMPT or LOCAL_GENERATE_LCT_PROMPT |
| Post-LLM node enrichment adds only `chunk_id` | `transcript_processing.py:982-983` | No speaker_id injection |

## Architecture Decision: Two Approaches

### Approach A: LLM-inferred speakers (simpler, less accurate)

Add `speaker_id` to the LLM prompt schema and let the LLM infer speakers from transcript text patterns (e.g., turn-taking cues, "I think..." vs "You said..."). No STT changes needed.

**Pros:** Zero STT changes, works with any provider, fast to implement
**Cons:** Unreliable — LLM guesses speakers from text cues; single-mic audio has no real speaker signal; hallucination risk for speaker assignment

### Approach B: STT-sourced diarization → LLM (more accurate, more work)

Extract speaker segments from WhisperX response, prefix transcript text with speaker labels before feeding to LLM, and add `speaker_id` to LLM output schema.

**Pros:** Real diarization data from WhisperX; speaker labels are grounded, not hallucinated
**Cons:** Requires WhisperX with diarization enabled (not all providers support it); more moving parts; WhisperX diarization needs HuggingFace token for pyannote

### Approach C: Hybrid — STT diarization when available, skip when not

Same as B, but gracefully degrade: if the STT response has no speaker segments, feed plain text to LLM without speaker labels. Nodes produced from diarized input get `speaker_id`; others don't.

**Pros:** Best of both worlds — accurate when available, doesn't break without it
**Cons:** Same implementation cost as B

**Recommendation:** Approach C. It's the same code as B with a nil check.

## Scope (Approach C)

### Layer 1: STT — Extract speaker segments from WhisperX

**File:** `lct_python_backend/services/stt_http_transcriber.py`

WhisperX returns a response like:
```json
{
  "segments": [
    {"start": 0.0, "end": 2.5, "text": "Hello there", "speaker": "SPEAKER_00"},
    {"start": 2.5, "end": 5.1, "text": "Hi, how are you", "speaker": "SPEAKER_01"}
  ]
}
```

Changes:
1. New function `extract_diarized_segments(payload)` that pulls `segments` with speaker labels when present
2. Modify `_transcribe_buffer` return to include optional `segments` field alongside `text`
3. `extract_transcript_text()` unchanged — still returns plain text for providers without diarization

**Risk:** WhisperX diarization requires `--diarize` flag and HuggingFace token on the server side. Need to verify the WhisperX instance at `100.81.65.74:8001` has it enabled.

### Layer 2: Accumulator — Prefix transcript with speaker labels

**File:** `lct_python_backend/services/transcript_processing.py`

Changes:
1. Modify `TranscriptProcessor.handle_final_text()` to accept optional speaker metadata
2. When building `input_text` from accumulated transcripts, prefix each segment with speaker label: `"[Speaker A]: Hello there\n[Speaker B]: Hi, how are you"`
3. If no speaker data available, join text as-is (current behavior — graceful degradation)

**Requires upstream change:** `_run_processor_final()` in `stt_api.py` currently passes only `text: str`. Needs to also pass speaker segments when available.

### Layer 3: LLM Prompt — Add `speaker_id` to node schema

**File:** `lct_python_backend/services/transcript_processing.py`

Changes to `GENERATE_LCT_PROMPT` and `LOCAL_GENERATE_LCT_PROMPT`:
1. Add `"speaker_id"` field to the node schema: `"speaker_id": "Speaker label from transcript (e.g., 'Speaker A'). Use null if not identifiable."`
2. Add instruction: "If the transcript includes speaker labels like `[Speaker A]:`, assign the corresponding speaker_id to each node."

### Layer 4: Post-LLM enrichment — Fallback speaker assignment

**File:** `lct_python_backend/services/transcript_processing.py`

After LLM returns nodes (line 982-983), if a node has no `speaker_id` (LLM didn't assign one), attempt to infer from the source excerpt by matching against the diarized segments stored in `chunk_dict`.

This is a best-effort fallback. The primary path is the LLM correctly copying the speaker label from the prefixed transcript.

### Layer 5: WebSocket transmission — No changes needed

`_send_processor_update()` already sends `existing_json` as-is. If nodes have `speaker_id`, it flows to the frontend automatically.

### Layer 6: Frontend — No changes needed

`MinimalGraph.jsx`, `graphConstants.js`, `TimelineRibbon.jsx`, `MinimalLegend.jsx` already handle `speaker_id`. The `buildSpeakerColorMap()` function assigns colors from the `SPEAKER_COLORS` palette.

## Relationship to ADR-012

ADR-012 describes a **full real-time diarization sidecar** (Diart + pyannote, dual-stream late-binding, speaker merging, correction windows). That's Phase 2-3 work.

This scope is **Phase 0** — the minimal wiring to get speaker colors working with what WhisperX already provides. It's a prerequisite: the LLM prompt and node schema need `speaker_id` regardless of whether diarization comes from WhisperX batch response or a streaming sidecar.

The changes here are forward-compatible with ADR-012:
- `speaker_id` in the node schema is permanent
- Speaker-labeled transcript input format works with any diarization source
- Graceful degradation means the streaming sidecar can be added later without breaking the existing path

## Verified: WhisperX Response Shape (2026-02-15)

Tested against `100.81.65.74:8001`. Health endpoint reports:
```json
{"status":"ok","model":"large-v3","device":"cuda","diarization":false,"backend":"whisperx"}
```

**Diarization is currently disabled.** Server needs `--diarize` flag + HuggingFace token (pyannote license).

Response shape with real audio (diarization off):
```json
{
  "text": "What about now? I want to basically",
  "language": "en",
  "duration": 5.0,
  "model": "large-v3",
  "timestamps": [
    {"start": 1.33, "end": 2.199, "text": "What about now?"},
    {"start": 2.704, "end": 4.017, "text": "I want to basically"}
  ],
  "speakers": null
}
```

When diarization is enabled, each timestamp entry gains a `speaker` field (`"SPEAKER_00"`, etc.) and `speakers` becomes a list.

**Action needed:** Enable diarization on the WhisperX server (`--diarize` + HF token).

## Resolved Questions

1. ~~Is WhisperX diarization enabled?~~ **No** — needs server-side config change. Code handles this gracefully (Approach C).
2. ~~Cross-chunk speaker reconciliation?~~ **Deferred to ADR-012.** Accept per-chunk labels for now.
3. **`handle_final_text` signature change:** `str → None` becomes `str, Optional[List[dict]] → None`. Minor cross-file change at `stt_api.py:427`.
4. **LLM prompt token cost:** ~50-100 extra tokens per call. Negligible for Gemini Flash.

## Estimated Effort

| Layer | Effort | Risk |
|-------|--------|------|
| 1. STT segment extraction | Small (new function + modify return) | Low — additive |
| 2. Accumulator speaker prefixing | Medium (signature change, text formatting) | Medium — cross-file |
| 3. LLM prompt schema | Small (add field + instruction) | Low — additive |
| 4. Post-LLM fallback | Small (best-effort matching) | Low — optional |
| **Total** | ~2-3 hours implementation | |

## Files Changed

- `lct_python_backend/services/stt_http_transcriber.py` — extract diarized segments
- `lct_python_backend/services/transcript_processing.py` — speaker-prefixed input, `speaker_id` in prompt, fallback enrichment
- `lct_python_backend/stt_api.py` — pass speaker segments to processor
- **No frontend changes**
