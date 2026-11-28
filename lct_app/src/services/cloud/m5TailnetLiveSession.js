// Test intent:
// - Checks the server's /health, then records the microphone in self-contained ~6 s slices and uploads
//   each slice to the configured HTTPS *.ts.net speech server, appending the returned passages with
//   their times shifted by the slice's position in the recording.
// - Every way of ending reaches a terminal stage the page can act on: a failed health check or a refused
//   microphone emits 'error'; Stop before anything is recorded cancels; Stop, Pause and Resume in any
//   order never leave a microphone open behind the session's back.
// - Each audio chunk carries its slice number and index, the shape the browser store saves.
// - One stalled request cannot hold up later slices or Stop: each has a deadline. Slices that fail are
//   retried once at Stop, and any still missing are reported as gaps in the transcript.
// - Fails closed: a configured address that is not allowed is refused by the health check, never
//   swapped for the default host; redirects are refused.
// - The server labels speakers per request, so a label is only meaningful within its slice. Labels are
//   namespaced by slice ("segment-N:SPEAKER_00"), as the cloud session does for each resumed part.

import { DEFAULT_M5_TAILNET_URL, parseM5Segments, probeM5TailnetEndpoint } from './m5TailnetFileSession.js';

const DEFAULT_SLICE_MS = 6000;
const DEFAULT_SLICE_TIMEOUT_MS = 60_000;
// How long to wait for a recorder's final data after asking it to stop.
const RECORDER_STOP_MS = 5000;
const TERMINAL = new Set(['stopped', 'cancelled', 'error']);

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

function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

export class M5TailnetLiveSession {
  constructor({
    url = DEFAULT_M5_TAILNET_URL,
    token = '',
    diarize = true,
    sliceMs = DEFAULT_SLICE_MS,
    sliceTimeoutMs = DEFAULT_SLICE_TIMEOUT_MS,
    onStage,
    onAudio,
    onAudioChunk,
    onTranscript,
    onMetrics,
    onFailure,
    onMicStream,
  } = {}) {
    // An empty address means the default; anything else is kept as given so the health check can refuse it.
    this.url = typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_M5_TAILNET_URL;
    this.token = typeof token === 'string' ? token.trim() : '';
    this.diarize = diarize;
    this.sliceMs = sliceMs;
    this.sliceTimeoutMs = sliceTimeoutMs;
    Object.assign(this, { onStage, onAudio, onAudioChunk, onTranscript, onMetrics, onFailure, onMicStream });

    this.controller = new AbortController();
    this.stream = null;
    this.recorder = null;
    this.sliceTimer = null;
    this.slicePending = null;
    this.sliceNumber = 0;
    this.mimeType = pickMimeType();
    this.segments = [];
    this.finalTokens = [];
    this.failedSlices = [];
    this.transcriptGaps = 0;
    this.uploadQueue = Promise.resolve();
    this.recordingStartedAt = 0;
    this.elapsedOffsetMs = 0;
    this.ttftMs = null;
    this.chunksCompleted = 0;
    this.opening = null;
    this.stopping = null;
    // idle | connecting | microphone | recording | pausing | paused | resuming | finalizing | stopped | cancelled | error
    this.state = 'idle';
  }

  async start() {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    this.onStage?.({ stage: 'connecting', message: 'Checking M5 Tailnet STT.', startedAt: Date.now() });
    const health = await probeM5TailnetEndpoint(this.url, { token: this.token, signal: this.controller.signal });
    if (this.state !== 'connecting') return; // stopped or cancelled while checking
    if (!health.ok) this.failStart(health.message || 'M5 Tailnet STT could not be reached.', { reason: 'health', canTryNext: true });
    this.state = 'microphone';
    this.onStage?.({ stage: 'microphone', message: 'Starting microphone for M5 Tailnet STT.', startedAt: Date.now() });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.state !== 'microphone') return;
      this.failStart(error?.message || 'Microphone access was denied.', { reason: 'microphone' });
    }
    if (this.state !== 'microphone') { stopStream(stream); return; }
    this.attach(stream);
    this.state = 'recording';
    this.recordingStartedAt = Date.now();
    this.onStage?.({ stage: 'recording', message: 'Recording with live M5 Tailnet transcription.', startedAt: this.recordingStartedAt, elapsedOffsetMs: 0 });
    this.beginSlice();
  }

  /** Ends a start that could not begin recording, with a stage the page treats as finished. */
  failStart(message, extra) {
    this.state = 'error';
    this.controller.abort();
    const failure = Object.assign(new Error(message), extra);
    this.onStage?.({ stage: 'error', message, startedAt: Date.now() });
    this.onFailure?.(failure);
    throw failure;
  }

  attach(stream) {
    this.stream = stream;
    for (const track of stream?.getAudioTracks?.() ?? stream?.getTracks?.() ?? []) {
      track.addEventListener?.('ended', () => {
        if (this.stream !== stream || this.state !== 'recording') return;
        this.onFailure?.(new Error('The microphone stopped. The audio recorded up to here is kept.'));
        void this.stop();
      }, { once: true });
    }
    this.onMicStream?.(stream);
  }

  releaseStream() {
    if (!this.stream) return;
    stopStream(this.stream);
    this.stream = null;
    this.onMicStream?.(null);
  }

  beginSlice() {
    if (this.state !== 'recording' || !this.stream) return;
    const number = ++this.sliceNumber;
    const chunks = [];
    let chunkIndex = 0, recorder, finish;
    const offsetMs = this.elapsedOffsetMs, startedAt = Date.now();
    this.slicePending = new Promise(resolve => { finish = resolve; });
    try {
      recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    } catch {
      finish();
      this.onFailure?.(new Error('Recording could not continue. The audio recorded up to here is kept.'));
      void this.stop();
      return;
    }
    const mimeType = () => recorder.mimeType || this.mimeType || 'audio/webm';
    recorder.ondataavailable = event => {
      // A recorder that outlived the 5 s wait after Stop belongs to a finished recording; its data is dropped.
      if (!(event?.data?.size > 0) || this.state === 'stopped' || this.state === 'error') return;
      chunks.push(event.data);
      this.onAudioChunk?.({ segment: number, index: chunkIndex++, mimeType: mimeType(), blob: event.data });
    };
    recorder.onstop = () => {
      if (this.recorder === recorder) this.recorder = null;
      finish();
      // Late: the recording already finished without it. Nothing more may change.
      if (this.state === 'stopped' || this.state === 'error') return;
      this.elapsedOffsetMs += Math.max(0, Date.now() - startedAt);
      if (chunks.length) {
        const blob = new Blob(chunks, { type: mimeType() });
        const slice = { number, blob, mimeType: mimeType(), offsetMs };
        this.segments.push({ number, blob, mimeType: slice.mimeType, complete: true });
        this.emitAudio(false);
        if (!this.controller.signal.aborted) this.uploadQueue = this.uploadQueue.then(() => this.transcribeSlice(slice));
      }
      // Only the current slice starts the next one; a late stop from an earlier slice must not add a recorder.
      if (this.state === 'recording' && this.sliceNumber === number) this.beginSlice();
    };
    this.recorder = recorder;
    try {
      recorder.start();
    } catch {
      this.recorder = null;
      finish();
      this.onFailure?.(new Error('Recording could not continue. The audio recorded up to here is kept.'));
      void this.stop();
      return;
    }
    clearTimeout(this.sliceTimer);
    this.sliceTimer = setTimeout(() => {
      if (this.recorder === recorder && recorder.state === 'recording') recorder.stop();
    }, this.sliceMs);
  }

  /** Stops the current slice, if any, and waits until its audio has been handed over. */
  async closeSlice() {
    clearTimeout(this.sliceTimer);
    this.sliceTimer = null;
    const pending = this.slicePending;
    if (this.recorder?.state === 'recording') {
      try { this.recorder.stop(); } catch { /* already stopping */ }
    }
    if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, RECORDER_STOP_MS))]);
  }

  async transcribeSlice(slice, { retry = false } = {}) {
    if (this.controller.signal.aborted || !slice.blob?.size) return;
    const startedAt = Date.now();
    const request = new AbortController();
    const relay = () => request.abort();
    this.controller.signal.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; request.abort(); }, this.sliceTimeoutMs);
    try {
      const form = new FormData();
      form.append('file', slice.blob, `slice-${slice.number}.${extensionForMime(slice.mimeType)}`);
      form.append('response_format', 'verbose_json');
      if (this.diarize) form.append('diarize', 'true');
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      const response = await fetch(this.url, { method: 'POST', body: form, headers, redirect: 'error', signal: request.signal });
      if (!response.ok) throw new Error(`returned HTTP ${response.status}`);
      const payload = await response.json();
      if (this.controller.signal.aborted) return;
      this.chunksCompleted += 1;
      this.addPassages(parseM5Segments(payload), slice);
      this.onMetrics?.({
        provider: 'm5_tailnet',
        ttftMs: this.ttftMs,
        lastLatencyMs: Math.max(0, Date.now() - startedAt),
        chunksCompleted: this.chunksCompleted,
        audioSeconds: Math.round(this.elapsedOffsetMs / 1000),
        costUsd: 0,
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const what = timedOut ? `did not answer within ${Math.round(this.sliceTimeoutMs / 1000)} s`
        : error?.name === 'TypeError' ? 'could not be reached (check Tailscale and the server\'s CORS setting)'
          : error?.message || 'failed';
      if (retry) { this.transcriptGaps += 1; return; }
      this.failedSlices.push(slice);
      const failure = new Error(`M5 Tailnet live transcription ${what}. ${this.state === 'finalizing' ? 'Trying this part once more.' : 'Recording continues, and this part is retried when you stop.'}`);
      failure.recoverable = true; // cleared by the page if the retry at Stop succeeds
      this.onFailure?.(failure);
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', relay);
    }
  }

  addPassages(parsed, slice) {
    if (!parsed.length) return;
    if (this.ttftMs == null) this.ttftMs = Math.max(0, Date.now() - this.recordingStartedAt);
    const shifted = parsed.map(token => ({
      ...token,
      speaker: token.speaker ? `segment-${slice.number}:${token.speaker}` : token.speaker,
      startMs: token.startMs + slice.offsetMs,
      endMs: token.endMs + slice.offsetMs,
    }));
    // A retried slice can arrive after later ones, so passages are kept in time order. Each passage is a
    // line of its own.
    const ordered = [...this.finalTokens, ...shifted].sort((a, b) => a.startMs - b.startMs);
    this.finalTokens = ordered.map((token, index) => {
      const text = token.text.replace(/^\n/, '');
      return { ...token, text: index ? `\n${text}` : text };
    });
    this.onTranscript?.({
      finalTokens: this.finalTokens,
      finalText: this.finalTokens.map(token => token.text).join(''),
      partialText: '',
      partialTokens: [],
    });
  }

  emitAudio(complete) {
    if (!this.segments.length) return;
    const mimeType = this.segments[0].mimeType;
    const blob = this.segments.length === 1 ? this.segments[0].blob : new Blob(this.segments.map(s => s.blob), { type: mimeType });
    this.onAudio?.({ blob, mimeType, complete, segments: [...this.segments], transcriptGaps: this.transcriptGaps });
  }

  async pause() {
    if (this.state !== 'recording') return;
    this.state = 'pausing';
    await this.closeSlice();
    this.releaseStream();
    if (this.state !== 'pausing') return; // stopped or cancelled meanwhile
    this.state = 'paused';
    this.onStage?.({ stage: 'paused', message: 'Paused. Microphone off.', startedAt: Date.now(), elapsedOffsetMs: this.elapsedOffsetMs });
  }

  resume() {
    if (this.state === 'resuming') return this.opening;
    if (this.state !== 'paused') return Promise.resolve();
    this.state = 'resuming';
    this.opening = (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (this.state !== 'resuming') return;
        this.state = 'paused';
        const failure = new Error(error?.message || 'Microphone access was denied.');
        this.onFailure?.(failure);
        throw failure;
      }
      if (this.state !== 'resuming') { stopStream(stream); return; } // stopped or cancelled meanwhile
      this.attach(stream);
      this.state = 'recording';
      this.onStage?.({ stage: 'recording', message: 'Recording with live M5 Tailnet transcription.', startedAt: Date.now(), elapsedOffsetMs: this.elapsedOffsetMs });
      this.beginSlice();
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (TERMINAL.has(this.state)) return Promise.resolve();
    // Nothing has been recorded yet, so there is nothing to finish.
    if (['idle', 'connecting', 'microphone'].includes(this.state)) { this.cancel(); return Promise.resolve(); }
    this.stopping = this.finish();
    return this.stopping;
  }

  async finish() {
    this.state = 'finalizing';
    this.onStage?.({ stage: 'finalizing', message: 'Finishing the last M5 Tailnet transcription…', startedAt: Date.now() });
    await this.closeSlice();
    this.releaseStream();
    await this.uploadQueue;
    for (const slice of this.failedSlices.splice(0)) await this.transcribeSlice(slice, { retry: true });
    if (this.controller.signal.aborted) return;
    this.state = 'stopped';
    this.emitAudio(true);
    if (this.transcriptGaps) {
      this.onFailure?.(new Error(`${this.transcriptGaps === 1 ? 'One part' : `${this.transcriptGaps} parts`} of this recording could not be transcribed, so the transcript has gaps. The audio is complete.`));
    }
    this.onStage?.({ stage: 'stopped', message: 'Recording finished (M5 Tailnet).', startedAt: Date.now() });
  }

  cancel() {
    if (TERMINAL.has(this.state)) return; // a finished recording stays finished
    this.state = 'cancelled';
    this.controller.abort();
    clearTimeout(this.sliceTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.releaseStream();
    this.onStage?.({ stage: 'cancelled', message: 'Recording cancelled.', startedAt: Date.now() });
  }
}
