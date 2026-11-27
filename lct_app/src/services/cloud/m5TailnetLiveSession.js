// Test intent:
// - Captures microphone audio via MediaRecorder, rolls self-contained audio slices every ~6s
//   (and on pause/stop) so every slice has a valid container header, and POSTs each slice to
//   the configured HTTPS *.ts.net M5 STT endpoint.
// - Offsets returned segment timestamps by slice start offset, appends them to finalTokens,
//   and emits live telemetry (TTFT ms, last chunk latency ms, audio duration, $0.00 cost).
// - Preserves full recorded audio and supports pause, resume, stop, and cancel cleanly.

import { DEFAULT_M5_TAILNET_URL, isAllowedTailnetUrl, parseM5Segments } from './m5TailnetFileSession.js';

const DEFAULT_SLICE_MS = 6000;

function pickMimeType() {
  if (typeof MediaRecorder?.isTypeSupported !== 'function') return 'audio/webm';
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function extensionForMime(mimeType) {
  if (String(mimeType || '').includes('mp4')) return 'm4a';
  if (String(mimeType || '').includes('ogg')) return 'ogg';
  return 'webm';
}

export class M5TailnetLiveSession {
  constructor({
    url = DEFAULT_M5_TAILNET_URL,
    token = '',
    diarize = true,
    sliceMs = DEFAULT_SLICE_MS,
    onStage,
    onAudio,
    onAudioChunk,
    onTranscript,
    onMetrics,
    onFailure,
    onMicStream,
  } = {}) {
    this.url = isAllowedTailnetUrl(url) ? url.trim() : DEFAULT_M5_TAILNET_URL;
    this.token = typeof token === 'string' ? token.trim() : '';
    this.diarize = diarize;
    this.sliceMs = sliceMs;
    this.onStage = onStage;
    this.onAudio = onAudio;
    this.onAudioChunk = onAudioChunk;
    this.onTranscript = onTranscript;
    this.onMetrics = onMetrics;
    this.onFailure = onFailure;
    this.onMicStream = onMicStream;

    this.controller = new AbortController();
    this.stream = null;
    this.recorder = null;
    this.sliceTimer = null;
    this.mimeType = pickMimeType();
    this.segments = [];
    this.finalTokens = [];
    this.uploadQueue = Promise.resolve();
    this.startedAt = 0;
    this.elapsedOffsetMs = 0;
    this.sliceStartedAt = 0;
    this.ttftMs = null;
    this.chunksCompleted = 0;
    this.state = 'idle'; // idle | recording | paused | finalizing | stopped | cancelled
  }

  async start() {
    this.startedAt = Date.now();
    this.state = 'recording';
    this.onStage?.({ stage: 'microphone', message: 'Starting microphone for M5 Tailnet STT.', startedAt: this.startedAt });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.state = 'cancelled';
      const msg = error?.message || 'Microphone access was denied.';
      this.onFailure?.(new Error(msg));
      throw error;
    }
    if (this.controller.signal.aborted) {
      this.stopTracks();
      return;
    }
    // The open microphone, for a level display only.
    this.onMicStream?.(this.stream);
    this.onStage?.({ stage: 'recording', message: 'Recording with live M5 Tailnet transcription.', startedAt: this.startedAt, elapsedOffsetMs: 0 });
    this.beginSlice();
  }

  beginSlice() {
    if (this.state !== 'recording' || !this.stream || this.controller.signal.aborted) return;
    const chunks = [];
    const sliceOffsetMs = this.elapsedOffsetMs;
    this.sliceStartedAt = Date.now();
    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    const recorder = new MediaRecorder(this.stream, options);
    this.recorder = recorder;

    recorder.ondataavailable = event => {
      if (event?.data?.size > 0) {
        chunks.push(event.data);
        this.onAudioChunk?.(event.data);
      }
    };

    recorder.onstop = () => {
      if (this.recorder === recorder) this.recorder = null;
      const sliceDurationMs = Math.max(0, Date.now() - this.sliceStartedAt);
      this.elapsedOffsetMs += sliceDurationMs;
      if (chunks.length) {
        const mimeType = recorder.mimeType || this.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: mimeType });
        const number = this.segments.length + 1;
        this.segments.push({ number, blob, mimeType, complete: true });
        this.emitAudio(false);
        if (!this.controller.signal.aborted) {
          this.uploadQueue = this.uploadQueue.then(() => this.transcribeSlice(blob, mimeType, sliceOffsetMs));
        }
      }
      if (this.state === 'recording' && !this.controller.signal.aborted) {
        this.beginSlice();
      }
    };

    recorder.start();
    clearTimeout(this.sliceTimer);
    this.sliceTimer = setTimeout(() => {
      if (this.recorder === recorder && recorder.state === 'recording') {
        recorder.stop();
      }
    }, this.sliceMs);
  }

  async transcribeSlice(blob, mimeType, offsetMs) {
    if (this.controller.signal.aborted || !blob?.size) return;
    const reqStart = Date.now();
    try {
      const form = new FormData();
      const ext = extensionForMime(mimeType);
      form.append('file', blob, `chunk-${this.chunksCompleted + 1}.${ext}`);
      form.append('response_format', 'verbose_json');
      if (this.diarize) form.append('diarize', 'true');
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      const response = await fetch(this.url, {
        method: 'POST',
        body: form,
        headers,
        signal: this.controller.signal,
      });
      const latencyMs = Math.max(0, Date.now() - reqStart);
      if (this.controller.signal.aborted) return;
      if (!response.ok) {
        throw new Error(`M5 Tailnet live transcription returned HTTP ${response.status}. Your audio is still being recorded.`);
      }
      const payload = await response.json();
      const parsed = parseM5Segments(payload);
      this.chunksCompleted += 1;
      if (parsed.length) {
        const isFirst = this.finalTokens.length === 0;
        if (isFirst && this.ttftMs == null) {
          this.ttftMs = Math.max(0, Date.now() - this.startedAt);
        }
        const shifted = parsed.map((token, idx) => ({
          ...token,
          text: (!isFirst && idx === 0 && !token.text.startsWith('\n') ? '\n' : '') + token.text,
          startMs: token.startMs + offsetMs,
          endMs: token.endMs + offsetMs,
        }));
        this.finalTokens = [...this.finalTokens, ...shifted];
        this.onTranscript?.({
          finalTokens: this.finalTokens,
          finalText: this.finalTokens.map(t => t.text).join(''),
          partialText: '',
          partialTokens: [],
        });
      }
      this.onMetrics?.({
        provider: 'm5_tailnet',
        ttftMs: this.ttftMs,
        lastLatencyMs: latencyMs,
        chunksCompleted: this.chunksCompleted,
        audioSeconds: Math.round(this.elapsedOffsetMs / 1000),
        costUsd: 0,
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const isNetwork = error?.name === 'TypeError';
      const err = isNetwork
        ? new Error('M5 Tailnet live transcription could not be reached (check Tailscale and CORS headers on the M5 server). Audio recording continues locally.')
        : error;
      this.onFailure?.(err);
    }
  }

  emitAudio(complete) {
    if (!this.segments.length) return;
    const mimeType = this.segments[0].mimeType;
    const blob = this.segments.length === 1
      ? this.segments[0].blob
      : new Blob(this.segments.map(s => s.blob), { type: mimeType });
    this.onAudio?.({ blob, mimeType, complete, segments: [...this.segments] });
  }

  stopTracks() {
    clearTimeout(this.sliceTimer);
    this.sliceTimer = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      this.onMicStream?.(null);
    }
  }

  async pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    clearTimeout(this.sliceTimer);
    if (this.recorder && this.recorder.state === 'recording') {
      await new Promise(resolve => {
        const prev = this.recorder.onstop;
        this.recorder.onstop = (...args) => { prev?.(...args); resolve(); };
        this.recorder.stop();
      });
    }
    this.onStage?.({ stage: 'paused', message: 'Recording paused. M5 Tailnet transcription paused.', startedAt: Date.now(), elapsedOffsetMs: this.elapsedOffsetMs });
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.onStage?.({ stage: 'recording', message: 'Recording with live M5 Tailnet transcription.', startedAt: Date.now(), elapsedOffsetMs: this.elapsedOffsetMs });
    this.beginSlice();
  }

  async stop() {
    if (this.state === 'stopped' || this.state === 'cancelled') return;
    this.state = 'finalizing';
    clearTimeout(this.sliceTimer);
    this.onStage?.({ stage: 'finalizing', message: 'Finishing final M5 Tailnet transcription chunk…', startedAt: Date.now() });
    if (this.recorder && this.recorder.state === 'recording') {
      await new Promise(resolve => {
        const prev = this.recorder.onstop;
        this.recorder.onstop = (...args) => { prev?.(...args); resolve(); };
        this.recorder.stop();
      });
    }
    this.stopTracks();
    await this.uploadQueue;
    if (this.controller.signal.aborted) return;
    this.state = 'stopped';
    this.emitAudio(true);
    this.onStage?.({ stage: 'stopped', message: 'Recording finished (M5 Tailnet).', startedAt: Date.now() });
  }

  cancel() {
    if (this.state === 'cancelled') return;
    this.state = 'cancelled';
    this.controller.abort();
    clearTimeout(this.sliceTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.stopTracks();
    this.onStage?.({ stage: 'cancelled', message: 'Recording cancelled.', startedAt: Date.now() });
  }
}
