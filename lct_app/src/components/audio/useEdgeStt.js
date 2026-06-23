import { useCallback, useRef } from "react";

import { concatPcmFrames, encodeWav, pcmBytesForSeconds } from "./wavEncoder";

/**
 * Edge STT — ADR-056 Phase 1 (flag-gated, ADDITIVE).
 *
 * Client-side speech-to-text that POSTs audio straight to the M5's
 * Tailscale-Serve HTTPS endpoint (`/v1/audio/transcriptions`), bypassing the
 * Asus relay (measured ~0.43s vs ~1.7–2.4s). NOT yet wired into the live
 * capture flow — the orchestrator opts in only when `VITE_STT_EDGE_ENABLED` is
 * set and the M5 is reachable.
 *
 * Contract with the rest of the pipeline:
 *  - same `onPCMFrame(buffer)` interface the capture hook already calls
 *    (16 kHz mono int16-LE frames);
 *  - buffers frames, flushes a WAV chunk every `chunkSeconds` and on stop;
 *  - emits each result via `onTranscript({utteranceId, isFinal, text, segments,
 *    speakers, speakerEmbeddings, ...})` for the orchestrator to forward to
 *    `/ws/transcripts` (ADR-056 #3 ingestion — built in a later increment);
 *  - on ANY error/timeout calls `onFallback(reason)` so the orchestrator can
 *    revert to the backend-orchestrated path (ADR-056 #4). A sleeping laptop /
 *    remote phone therefore degrades instead of stalling capture.
 *
 * Security (recalibrated to the personal threat model — ADR-056): the M5
 * endpoint is reached over Tailscale-Serve HTTPS and gated by the existing
 * `AUTH_TOKEN`; no capability-token machinery.
 */
export default function useEdgeStt({
  url,
  authToken,
  diarize = false,
  includeEmbeddings = false,
  language,
  chunkSeconds = 1.2,
  timeoutMs = 8000,
  sampleRateHz = 16000,
  onTranscript,
  onError,
  onFallback,
}) {
  const framesRef = useRef([]);
  const bufferedBytesRef = useRef(0);
  const utteranceRef = useRef(0);
  const stoppedRef = useRef(false);

  const chunkBytesTarget = pcmBytesForSeconds(chunkSeconds, sampleRateHz);

  const reset = useCallback(() => {
    framesRef.current = [];
    bufferedBytesRef.current = 0;
    utteranceRef.current = 0;
    stoppedRef.current = false;
  }, []);

  const postChunk = useCallback(
    async (pcmBytes, isFinal) => {
      if (!url || pcmBytes.byteLength === 0) return;
      utteranceRef.current += 1;
      const utteranceId = utteranceRef.current;

      const form = new FormData();
      form.append("file", encodeWav(pcmBytes, sampleRateHz), `edge-${utteranceId}.wav`);
      if (diarize) form.append("diarize", "true");
      if (includeEmbeddings) form.append("include_embeddings", "true");
      if (language) form.append("language", language);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          body: form,
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`edge STT HTTP ${resp.status}`);
        const data = await resp.json();
        onTranscript?.({
          utteranceId,
          isFinal: Boolean(isFinal),
          text: (data.text || "").trim(),
          segments: data.segments || null,
          speakers: data.speakers || null,
          speakerEmbeddings: data.speaker_embeddings || null,
          language: data.language || null,
          engine: data._engine || "edge",
        });
      } catch (error) {
        onError?.(error);
        // ADR-056 #4: any edge failure signals the orchestrator to fall back.
        onFallback?.(error?.name === "AbortError" ? "edge_timeout" : "edge_error");
      } finally {
        clearTimeout(timer);
      }
    },
    [url, authToken, diarize, includeEmbeddings, language, timeoutMs, sampleRateHz, onTranscript, onError, onFallback]
  );

  const drain = useCallback(
    (isFinal) => {
      if (bufferedBytesRef.current === 0) return;
      const frames = framesRef.current;
      framesRef.current = [];
      bufferedBytesRef.current = 0;
      void postChunk(concatPcmFrames(frames), isFinal);
    },
    [postChunk]
  );

  /** Called by the capture hook on each PCM frame. */
  const onPCMFrame = useCallback(
    (buffer) => {
      if (stoppedRef.current || !buffer || buffer.byteLength === 0) return;
      framesRef.current.push(buffer);
      bufferedBytesRef.current += buffer.byteLength;
      if (bufferedBytesRef.current >= chunkBytesTarget) drain(false);
    },
    [chunkBytesTarget, drain]
  );

  /** Flush whatever is buffered as a final chunk (call on stop/pause). */
  const flush = useCallback(() => drain(true), [drain]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    drain(true);
  }, [drain]);

  return { onPCMFrame, flush, stop, reset };
}
