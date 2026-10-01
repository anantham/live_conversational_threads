import { SonioxStream } from './sonioxStream.js';
import { recordRecordingTiming } from './recordingTiming.js';

const MAX_AUDIO_BYTES = 2097152;
const MIC_WAIT_MS = 15000;
const SESSION_WAIT_MS = 10000;
const RECORDER_STOP_MS = 3000;
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const error = (message) => new Error(`Recording ${message}`);

async function readSessionResponse(response, signal) {
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (raw.length * 4 > 8192) throw error('authorization returned an oversized response.');
    return raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return raw + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw error('authorization returned an oversized response.');
      }
      raw += decoder.decode(value, { stream: true });
    }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function defaultRequestSession({ signal }) {
  const response = await fetch('/api/cloud/soniox/session', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-LCT-Soniox-Consent': 'transcribe-v1' }, signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw error(response.status === 401 ? 'requires ChatGPT sign-in for this transcription test.' : 'authorization failed; check shared session limits and provider availability before retrying.');
  }
  const raw = await readSessionResponse(response, signal);
  try { return JSON.parse(raw); }
  catch { throw error('authorization returned an invalid response.'); }
}

function bounded(promise, ms, signal, label, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      handler(value);
    };
    const abort = () => finish(reject, error('was canceled.'));
    const timer = setTimeout(() => {
      finish(reject, error(`${label} timed out.`));
      onTimeout?.();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then((value) => finish(resolve, value), () => finish(reject, error(`${label} failed.`)));
  });
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    try { track.stop(); } catch { /* best effort */ }
  }
}

export class RecordingSession {
  constructor({ onStage, onAudio, onTranscript, onFailure, StreamClass = SonioxStream,
    mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorderClass = globalThis.MediaRecorder,
    requestSession = defaultRequestSession } = {}) {
    this.onStage = onStage;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onFailure = onFailure;
    this.StreamClass = StreamClass;
    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.requestSession = requestSession;
    this.state = 'idle';
    this.generation = 0;
  }

  stage(stage, message) {
    const now = Date.now();
    if (['microphone', 'authorizing', 'connecting', 'recording', 'finalizing'].includes(this.state)) recordRecordingTiming(this.state, this.mode, this.phaseStartedAt, stage === 'error' ? message.includes('timed out') ? 'timeout' : 'error' : stage === 'cancelled' ? 'cancelled' : 'success');
    this.phaseStartedAt = now;
    this.state = stage;
    try { this.onStage?.({ stage, startedAt: now, message }); } catch { /* caller owns callback */ }
  }

  async start({ transcribe = false, maxSessionSeconds = 300 } = {}) {
    if (!['idle', 'stopped', 'cancelled', 'error'].includes(this.state)) throw error('is already active.');
    if (!Number.isInteger(maxSessionSeconds) || maxSessionSeconds < 1 || maxSessionSeconds > 18000) throw error('requires a valid maximum duration.');
    if (!this.mediaDevices?.getUserMedia || !this.MediaRecorderClass) throw error('microphone recording is unavailable.');
    const generation = ++this.generation;
    this.startedAt = Date.now();
    this.mode = transcribe ? 'transcription' : 'local';
    this.abort = new AbortController();
    this.chunks = [];
    this.bytes = 0;
    this.audioEmitted = false;
    this.incomplete = false;
    this.providerFailed = false;
    this.failureEmitted = false;
    this.stopPromise = null;
    this.stream = null;
    this.recorder = null;
    this.mediaStream = null;
    this.stage('microphone', 'Waiting for microphone access.');
    try {
      const micPromise = Promise.resolve().then(() => this.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
      micPromise.then((stream) => {
        if (this.generation !== generation || this.state !== 'microphone') stopTracks(stream);
      }, () => {});
      this.mediaStream = await bounded(micPromise, MIC_WAIT_MS, this.abort.signal, 'microphone');
      if (this.generation !== generation || this.abort.signal.aborted) throw error('was canceled.');
      let providerCap = null;
      let providerConnectedAt = null;
      if (transcribe) {
        this.stage('authorizing', 'Authorizing live transcription.');
        const response = await bounded(
          Promise.resolve().then(() => this.requestSession({ signal: this.abort.signal })),
          SESSION_WAIT_MS, this.abort.signal, 'authorization', () => this.abort.abort(),
        );
        if (this.generation !== generation || this.abort.signal.aborted) throw error('was canceled.');
        if (!response || typeof response !== 'object' || Array.isArray(response)
          || typeof response.api_key !== 'string' || !response.api_key || response.api_key.length > 4096
          || typeof response.expires_at !== 'string' || response.expires_at.length > 64
          || typeof response.session_id !== 'string' || !response.session_id || response.session_id.length > 256
          || !Number.isInteger(response.max_session_seconds)
          || response.max_session_seconds < 15 || response.max_session_seconds > 900) {
          throw error('authorization returned an invalid session.');
        }
        providerCap = response.max_session_seconds;
        this.stage('connecting', 'Connecting live transcription.');
        this.stream = new this.StreamClass({
          onTranscript: (snapshot) => {
            if (this.generation === generation && ['recording', 'finalizing'].includes(this.state)) {
              try { this.onTranscript?.(snapshot); } catch { /* caller owns callback */ }
            }
          },
          onFailure: () => { if (this.generation === generation) this.providerFailure(); },
          onFinished: () => {
            if (this.generation === generation && this.state === 'recording') this.providerFailure();
          },
        });
        await bounded(this.stream.connect({ apiKey: response.api_key, expiresAt: response.expires_at,
          maxSessionSeconds: providerCap, signal: this.abort.signal }), SESSION_WAIT_MS,
        this.abort.signal, 'connection', () => this.abort.abort());
        providerConnectedAt = Date.now();
        if (this.generation !== generation || this.abort.signal.aborted) throw error('was canceled.');
      }
      const mimeType = TYPES.find((type) => this.MediaRecorderClass.isTypeSupported?.(type));
      if (!mimeType) throw error('has no supported audio format.');
      this.mimeType = mimeType;
      this.recorder = new this.MediaRecorderClass(this.mediaStream, { mimeType, audioBitsPerSecond: 32000 });
      const onData = (event) => {
        if (this.generation === generation) this.acceptChunk(event.data);
      };
      const onError = () => {
        if (this.generation === generation) this.fail(error('audio capture failed.'));
      };
      const recorder = this.recorder;
      recorder.addEventListener('dataavailable', onData);
      recorder.addEventListener('error', onError);
      this.detachRecorder = () => { recorder.removeEventListener('dataavailable', onData); recorder.removeEventListener('error', onError); };
      this.recorder.start(250);
      this.stage('recording', transcribe ? 'Recording and transcribing.' : 'Recording locally.');
      const providerDeadline = providerCap == null ? Infinity : providerConnectedAt + providerCap * 1000 - 5000;
      const requestedDeadline = Date.now() + maxSessionSeconds * 1000 - (transcribe ? 5000 : 0);
      this.cutTimer = setTimeout(() => { if (this.generation === generation && this.state === 'recording') void this.stop(); },
        Math.max(0, Math.min(providerDeadline, requestedDeadline) - Date.now()));
    } catch (cause) {
      if (this.generation !== generation || this.state === 'cancelled') throw error('was canceled.');
      const safe = cause instanceof Error && cause.message.startsWith('Recording ') ? cause : error('could not start.');
      this.fail(safe);
      throw safe;
    }
  }

  acceptChunk(blob) {
    if (!['recording', 'finalizing'].includes(this.state) || !blob || !Number.isFinite(blob.size) || blob.size <= 0) return;
    if (this.bytes + blob.size > MAX_AUDIO_BYTES) {
      this.incomplete = true;
      if (this.state === 'recording') void this.stop();
      return;
    }
    this.chunks.push(blob);
    this.bytes += blob.size;
    if (this.stream && !this.providerFailed) {
      try { this.stream.sendAudio(blob); }
      catch { this.providerFailure(); }
    }
  }

  providerFailure() {
    if (this.providerFailed || ['idle', 'stopped', 'cancelled', 'error'].includes(this.state)) return;
    this.providerFailed = true;
    this.incomplete = true;
    this.notifyFailure(error('live transcription failed; local audio was retained.'));
    if (this.state === 'recording') void this.stop();
  }

  notifyFailure(cause) {
    if (this.failureEmitted) return;
    this.failureEmitted = true;
    try { this.onFailure?.(cause); } catch { /* caller owns callback */ }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (['microphone', 'authorizing', 'connecting'].includes(this.state)) { this.cancel(); return Promise.resolve(); }
    if (this.state !== 'recording') return Promise.resolve();
    const generation = this.generation;
    const recorder = this.recorder;
    const mediaStream = this.mediaStream;
    const stream = this.stream;
    const signal = this.abort.signal;
    this.stage('finalizing', 'Finalizing recording.');
    clearTimeout(this.cutTimer);
    this.stopPromise = (async () => {
      let recorderStopped = false;
      try {
        if (recorder?.state !== 'inactive') {
          const stopped = new Promise((resolve) => {
            const finish = (value) => {
              clearTimeout(timer);
              recorder.removeEventListener('stop', onStop);
              signal.removeEventListener('abort', onAbort);
              resolve(value);
            };
            const onStop = () => finish(true);
            const onAbort = () => finish(false);
            const timer = setTimeout(() => finish(false), RECORDER_STOP_MS);
            recorder.addEventListener('stop', onStop, { once: true });
            signal.addEventListener('abort', onAbort, { once: true });
          });
          recorder.stop();
          stopTracks(mediaStream);
          recorderStopped = await stopped;
        } else {
          stopTracks(mediaStream);
          recorderStopped = true;
        }
      } catch { this.incomplete = true; stopTracks(mediaStream); }
      if (this.generation !== generation) return;
      this.detachRecorder?.();
      if (!recorderStopped) this.incomplete = true;
      if (stream) {
        if (this.providerFailed) stream.cancel();
        else {
          try {
            await bounded(stream.finish(), SESSION_WAIT_MS, this.abort.signal, 'finalization', () => stream.cancel());
          }
          catch { this.providerFailure(); stream.cancel(); }
        }
      }
      if (this.generation !== generation) return;
      this.emitAudio(!this.incomplete);
      if (this.generation === generation && this.state !== 'cancelled') this.stage(this.providerFailed ? 'error' : 'stopped',
        this.providerFailed ? 'Live transcription ended; local audio is available.' : this.incomplete ? 'Recording stopped; partial audio is available.' : 'Recording complete.');
    })();
    return this.stopPromise;
  }

  emitAudio(complete) {
    if (this.audioEmitted || !this.bytes) return;
    this.audioEmitted = true;
    try { this.onAudio?.({ blob: new Blob(this.chunks, { type: this.mimeType }), mimeType: this.mimeType, complete }); }
    catch { /* caller owns callback */ }
  }

  fail(cause) {
    clearTimeout(this.cutTimer);
    this.abort?.abort();
    this.stream?.cancel();
    this.detachRecorder?.();
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* best effort */ }
    stopTracks(this.mediaStream);
    this.incomplete = true;
    this.emitAudio(false);
    this.stage('error', cause.message);
    this.notifyFailure(cause);
  }

  cancel() {
    if (['idle', 'stopped', 'cancelled', 'error'].includes(this.state)) return;
    this.generation += 1;
    clearTimeout(this.cutTimer);
    this.abort?.abort();
    this.stream?.cancel();
    this.detachRecorder?.();
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* best effort */ }
    stopTracks(this.mediaStream);
    this.incomplete = true;
    this.emitAudio(false);
    this.stage('cancelled', 'Recording canceled.');
  }
}
