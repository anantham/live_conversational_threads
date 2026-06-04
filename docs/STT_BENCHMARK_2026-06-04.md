# STT Backend Benchmark — asus (RTX 3080 Laptop, 16GB) — 2026-06-04

Empirical numbers, collected one backend at a time on the **same 90s clip**
(first 90s of File A, mono 16kHz). Direct/in-process via the `whisperlocal`
conda env, EXCEPT parakeet which is the `:5092` docker HTTP server. Sequential
(shared GPU). The `transcription_runs` telemetry table the registry described
was empty — this is the first real data.

`RTF` = transcribe_time / audio_time (lower = faster). `xRT` = realtime multiple.

| backend | model | diarize | load_s | transcribe_s | diarize_s | RTF | xRT | words | chars |
|---|---|---|---|---|---|---|---|---|---|
| parakeet_http (:5092 docker) | parakeet-tdt-0.6b | no | 0.0 | **29.1** | – | 0.324 | 3.1× | 35 | 168 |
| faster_whisper | large-v3 | no | 6.5 | 11.1 | – | 0.123 | 8.1× | 293 | 1513 |
| **whisperx** | large-v3 | no | 6.9 | **8.0** | 0.0 | **0.089** | **11.2×** | 288 | 1508 |
| **whisperx** | large-v3 | **yes** | 5.0 | 3.9 | **5.0** | **0.099** | **10.1×** | 288 | 1508 |

## Headline findings

1. **Pure transcription is NOT the bottleneck.** whisperx and faster_whisper
   both do 90s in ~8–11s (8–11× realtime). The GPU is plenty fast.

2. **Diarization is cheap here — only ~5s for 90s** (whisperx+diar still 10×
   realtime). This *overturns* the earlier hypothesis that diarization was the
   slow part.

3. **The real slowness is ORCHESTRATION OVERHEAD, not the model.** The earlier
   end-to-end run was ~1× realtime (39 min for 41 min). Direct-to-model is
   **~10× realtime**. The ~10× gap is the IndrasNet path: `:7777`→WSL hop,
   85 per-chunk HTTP round-trips, cold-starts, and the restart cascade. Going
   direct (or batching) would cut a 41-min file from ~39 min to **~4–5 min**.

4. **Parakeet docker is both slow AND lossy here** — 3× realtime (slowest) and
   only 35 words vs ~290 for the same clip. It's dropping ~88% of content
   (likely a VAD/segmentation issue in that container). Not usable as-is.

5. **whisperx ≈ faster_whisper on text** (same CTranslate2 core, near-identical
   output); whisperx edges ahead and adds cheap diarization. faster_whisper is
   the lighter dependency if diarization isn't needed.

## Recommendation

- **Best single backend: `whisperx large-v3` with diarization, called
  DIRECTLY (in-process or one batched call), not through the per-chunk
  `:7777` orchestrator.** ~10× realtime WITH speakers.
- **The optimization that matters is the integration path, not the model:**
  replace LCT's 85-chunk HTTP-to-orchestrator with either (a) one direct
  whisperx call on the whole file, or (b) far larger chunks. Expected: 41-min
  file in ~4–5 min instead of ~39 min.
- **Drop Parakeet** until its content-loss is fixed.
- **faster_whisper** is the fallback for text-only/no-diar speed.

## Caveats / not-yet-measured
- One 90s clip, one speaker detected (SPEAKER_00) in this segment — diarization
  cost may rise on longer multi-speaker audio (pyannote clustering scales with
  length + speaker count). Worth a longer-clip re-bench before final call.
- WER/accuracy not formally scored — only char/word count as a completeness
  proxy. faster_whisper & whisperx outputs read clean; Parakeet is sparse.
- mlx-whisper on the M5 not tested (M5 has no STT service today).
