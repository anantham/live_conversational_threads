import { useCallback, useRef } from "react";

import { concatPcmFrames, encodeWav, pcmBytesForSeconds } from "./wavEncoder";

/**
 * Edge STT — ADR-056 Phase 1 (flag-gated, ADDITIVE).
 *
 * Client-side STT that POSTs audio straight to the M5's Tailscale-Serve HTTPS
 * endpoint (`/v1/audio/transcriptions`), bypassing the Asus relay (measured
 * ~0.43s vs ~1.7–2.4s). The orchestrator opts in only when the runtime flag is
 * on (see `edgeConfig`), and reverts to the backend-orchestrated path on any
 * edge failure via `onFallback`.
 *
 * Contract:
 *  - `onPCMFrame(buffer)` — same interface the capture hook calls (16 kHz mono
 *    int16-LE frames); buffers them, flushes a WAV chunk every `chunkSeconds`.
 *  - Each chunk is an independent, COMPLETE transcription of its time-slice, so
 *    it is emitted with `isFinal: true` (→ `transcript_final`, which the backend
 *    persists). POSTs are **serialized** (a promise chain) so `onTranscript`
 *    fires in chunk order even though fetches overlap in wall-clock.
 *  - `reset()` bumps a generation id and aborts in-flight requests, so stale
 *    results from a previous session can't leak into a new one.
 *  - `stop()` flushes the tail and RETURNS a promise that resolves once the
 *    final chunk's POST + `onTranscript` complete — await it before closing the
 *    transcript WebSocket so the last result isn't dropped.
 *  - `onFallback(reason)` fires on any error/timeout (or a missing url), so a
 *    sleeping laptop / remote phone degrades to the backend path.
 *
 * Security (recalibrated personal threat model — ADR-056): the M5 endpoint is
 * reached over Tailscale-Serve HTTPS on a trusted tailnet and is currently
 * UNAUTHENTICATED; `authToken`, if provided, is sent as a bearer for when the
 * endpoint is later locked down.
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
  const genRef = useRef(0); // generation; bumped on reset to invalidate in-flight work
  const chainRef = useRef(Promise.resolve()); // serializes POSTs in chunk order
  const controllersRef = useRef(new Set());
  const stoppedRef = useRef(false);
  const noUrlReportedRef = useRef(false);
  const pendingRef = useRef(0); // in-flight/queued chunk count (backlog cap)

  const chunkBytesTarget = pcmBytesForSeconds(chunkSeconds, sampleRateHz);
  const MAX_PENDING = 4; // edge can't keep up beyond this -> fall back to relay

  const reset = useCallback(() => {
    genRef.current += 1; // invalidate any chunk enqueued/in-flight under the old gen
    controllersRef.current.forEach((c) => {
      try {
        c.abort();
      } catch {
        /* already settled */
      }
    });
    controllersRef.current.clear();
    chainRef.current = Promise.resolve();
    framesRef.current = [];
    bufferedBytesRef.current = 0;
    utteranceRef.current = 0;
    stoppedRef.current = false;
    noUrlReportedRef.current = false;
    // NOTE: do NOT zero pendingRef here — the previous chain's `.finally` handlers
    // still run as those (now-aborted) requests settle and decrement it. Each
    // enqueue has exactly one decrement, so the count stays >= 0 and accurate
    // across reset; zeroing it would let those late decrements drive it negative
    // and defeat the backlog cap.
  }, []);

  const postChunk = useCallback(
    async (pcmBytes, gen) => {
      if (gen !== genRef.current) return; // stale (reset happened between enqueue and run)
      if (!url) {
        if (!noUrlReportedRef.current) {
          noUrlReportedRef.current = true;
          onFallback?.("no_edge_url");
        }
        return;
      }
      if (pcmBytes.byteLength === 0) return;

      const controller = new AbortController();
      controllersRef.current.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Build inside the try so a throw here can't reject the chain link.
        utteranceRef.current += 1;
        const utteranceId = utteranceRef.current;
        const form = new FormData();
        form.append("file", encodeWav(pcmBytes, sampleRateHz), `edge-${utteranceId}.wav`);
        if (diarize) form.append("diarize", "true");
        if (includeEmbeddings) form.append("include_embeddings", "true");
        if (language) form.append("language", language);

        const resp = await fetch(url, {
          method: "POST",
          body: form,
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          signal: controller.signal,
        });
        if (gen !== genRef.current) return; // reset while in flight
        if (!resp.ok) throw new Error(`edge STT HTTP ${resp.status}`);
        const data = await resp.json();
        if (gen !== genRef.current) return;
        const text = (data.text || "").trim();
        const segments = Array.isArray(data.segments) ? data.segments : null;
        if (!text && !(segments && segments.length)) return; // suppress empty/silence
        onTranscript?.({
          utteranceId,
          isFinal: true, // each time-slice chunk is a complete transcription
          text,
          segments,
          speakers: data.speakers || null,
          speakerEmbeddings: data.speaker_embeddings || null,
          language: data.language || null,
          engine: data._engine || "edge",
        });
      } catch (error) {
        if (gen !== genRef.current) return; // aborted by reset — benign
        // a real failure (incl. a timeout AbortError) -> revert to the relay path
        onError?.(error);
        onFallback?.(error?.name === "AbortError" ? "edge_timeout" : "edge_error");
      } finally {
        clearTimeout(timer);
        controllersRef.current.delete(controller);
      }
    },
    [url, authToken, diarize, includeEmbeddings, language, timeoutMs, sampleRateHz, onTranscript, onError, onFallback]
  );

  // Flush buffered frames as one chunk; serialize behind prior chunks so
  // onTranscript (and the caller's WS sends) stay in order. Returns the chain
  // tail so callers can await completion.
  const drain = useCallback(() => {
    if (bufferedBytesRef.current === 0) return chainRef.current;
    const frames = framesRef.current;
    framesRef.current = [];
    bufferedBytesRef.current = 0;
    // Backlog cap: if POSTs can't keep up, don't queue audio unboundedly (which
    // would also stall stop()) — drop this slice and fall back to the relay.
    if (pendingRef.current >= MAX_PENDING) {
      onFallback?.("edge_backlog");
      return chainRef.current;
    }
    const gen = genRef.current;
    const pcm = concatPcmFrames(frames);
    pendingRef.current += 1;
    chainRef.current = chainRef.current
      .then(() => postChunk(pcm, gen))
      .catch(() => {}) // a poisoned link must never break the chain
      .finally(() => {
        pendingRef.current -= 1;
      });
    return chainRef.current;
  }, [postChunk, onFallback]);

  /** Called by the capture hook on each PCM frame. */
  const onPCMFrame = useCallback(
    (buffer) => {
      if (stoppedRef.current || !buffer || buffer.byteLength === 0) return;
      framesRef.current.push(buffer);
      bufferedBytesRef.current += buffer.byteLength;
      if (bufferedBytesRef.current >= chunkBytesTarget) drain();
    },
    [chunkBytesTarget, drain]
  );

  /**
   * Flush the tail and resolve when the final chunk's POST + onTranscript are
   * done. Await before closing the transcript WS (stop/pause).
   */
  const stop = useCallback(() => {
    stoppedRef.current = true;
    return drain();
  }, [drain]);

  return { onPCMFrame, stop, reset };
}
