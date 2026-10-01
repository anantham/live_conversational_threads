const URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const MAX_FRAME_BYTES = 262144;
const MAX_BUFFERED_BYTES = 1048576;
const MAX_TRANSCRIPT_BYTES = 524288;
const MAX_RESPONSE_BYTES = 524288;
const MAX_TOKENS = 8192;
const WAIT_MS = 10000;
const ERROR_TYPES = new Set(['invalid_request', 'model_not_available', 'unauthenticated', 'permission_denied', 'temp_api_key_session_expired', 'organization_balance_exhausted', 'organization_monthly_budget_exhausted', 'project_monthly_budget_exhausted', 'request_timeout', 'max_duration_reached', 'limit_exceeded', 'internal_error', 'service_unavailable']);

const fail = (message) => new Error(`Live transcription ${message}`);

function normalizeToken(token) {
  if (!token || typeof token !== 'object' || Array.isArray(token) || typeof token.text !== 'string' || typeof token.is_final !== 'boolean') {
    throw fail('received an invalid token.');
  }
  if (token.text.length > MAX_RESPONSE_BYTES || (token.speaker != null && (typeof token.speaker !== 'string' || token.speaker.length > 128))) throw fail('received an invalid token.');
  for (const field of ['start_ms', 'end_ms']) {
    if (token[field] != null && (!Number.isFinite(token[field]) || token[field] < 0)) throw fail('received an invalid token.');
  }
  if (token.start_ms != null && token.end_ms != null && token.end_ms < token.start_ms) throw fail('received an invalid token.');
  return {
    text: token.text,
    speaker: token.speaker ?? null,
    startMs: token.start_ms ?? null,
    endMs: token.end_ms ?? null,
  };
}

export class SonioxStream {
  constructor({ onTranscript, onFailure, onFinished, WebSocketClass = globalThis.WebSocket } = {}) {
    this.onTranscript = onTranscript;
    this.onFailure = onFailure;
    this.onFinished = onFinished;
    this.WebSocketClass = WebSocketClass;
    this.state = 'idle';
    this.serial = 0;
    this.finalTokens = [];
    this.partialTokens = [];
    this.transcriptBytes = 0;
  }

  async connect({ apiKey, expiresAt, maxSessionSeconds, signal } = {}) {
    if (!['idle', 'closed'].includes(this.state)) throw fail('session is already active.');
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) throw fail('requires a valid temporary key.');
    const expiration = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    if (!Number.isFinite(expiration) || expiration <= Date.now()) throw fail('temporary key has expired.');
    if (!Number.isInteger(maxSessionSeconds) || maxSessionSeconds < 1 || maxSessionSeconds > 18000) throw fail('requires a valid session duration.');
    if (signal?.aborted) throw fail('was canceled.');
    if (typeof this.WebSocketClass !== 'function') throw fail('is unavailable in this browser.');

    this.cleanup();
    this.serial += 1;
    const serial = this.serial;
    this.finalTokens = [];
    this.partialTokens = [];
    this.transcriptBytes = 0;
    this.state = 'connecting';
    let socket;
    try { socket = new this.WebSocketClass(URL); }
    catch { this.state = 'closed'; throw fail('could not open a connection.'); }
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let pendingKey = apiKey;
      apiKey = null;
      this.connectReject = reject;
      const current = () => this.serial === serial;
      const onOpen = () => {
        if (!current() || this.state !== 'connecting') return;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        try {
          socket.send(JSON.stringify({ api_key: pendingKey, model: 'stt-rt-v5', audio_format: 'auto', enable_speaker_diarization: true, enable_endpoint_detection: true }));
          pendingKey = null;
        } catch {
          pendingKey = null;
          this.terminate(fail('could not configure the session.'));
          return;
        }
        this.connectReject = null;
        this.state = 'active';
        this.durationTimer = setTimeout(() => {
          if (!current() || this.state !== 'active') return;
          try { this.onFailure?.(fail('reached its maximum duration.')); } catch { /* caller owns callback */ }
          this.finish().catch(() => {});
        }, maxSessionSeconds * 1000);
        resolve();
      };
      const onMessage = (event) => { if (current()) this.receive(event.data); };
      const onClose = () => { if (current() && this.state !== 'closed') this.terminate(fail('connection closed before completion.')); };
      const onError = () => { if (current()) this.terminate(fail('connection failed.')); };
      const onAbort = () => { if (current()) this.terminate(fail('was canceled.')); };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.detach = () => {
        pendingKey = null;
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      this.connectTimer = setTimeout(() => { if (current()) this.terminate(fail('connect timed out.')); }, WAIT_MS);
    });
  }

  sendAudio(frame) {
    if (this.state !== 'active' || this.socket?.readyState !== 1) throw fail('session is not active.');
    const valid = frame instanceof ArrayBuffer || (typeof Blob !== 'undefined' && frame instanceof Blob);
    if (!valid || frame.size === 0 || frame.byteLength === 0 || (frame.size ?? frame.byteLength) > MAX_FRAME_BYTES) {
      throw fail('audio frame must be nonempty and at most 262144 bytes.');
    }
    if (this.socket.bufferedAmount + (frame.size ?? frame.byteLength) > MAX_BUFFERED_BYTES) throw fail('audio backpressure limit reached.');
    try { this.socket.send(frame); }
    catch { this.terminate(fail('could not send audio.')); throw fail('could not send audio.'); }
  }

  finish() {
    if (this.state === 'finishing' && this.finishPromise) return this.finishPromise;
    if (this.state !== 'active') return Promise.reject(fail('session is not active.'));
    this.state = 'finishing';
    clearTimeout(this.durationTimer);
    this.durationTimer = null;
    this.finishPromise = new Promise((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
      this.finishTimer = setTimeout(() => this.terminate(fail('finish timed out.')), WAIT_MS);
      try { this.socket.send(''); }
      catch { this.terminate(fail('could not finish the session.')); }
    });
    return this.finishPromise;
  }

  cancel() { this.terminate(fail('was canceled.'), false); }

  receive(raw) {
    if (!['active', 'finishing'].includes(this.state)) return;
    try {
      if (typeof raw !== 'string' || raw.length * 4 > MAX_RESPONSE_BYTES) throw fail('received an oversized or invalid response.');
      const response = JSON.parse(raw);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw fail('received an invalid response.');
      if (response.error_type != null || response.error_code != null) {
        const type = ERROR_TYPES.has(response.error_type) ? response.error_type : 'unknown_error';
        throw fail(`provider error (${type}).`);
      }
      if (!Array.isArray(response.tokens) || response.tokens.length > MAX_TOKENS || (response.finished != null && typeof response.finished !== 'boolean')) throw fail('received an invalid response.');
      const hadPartial = this.partialTokens.length > 0;
      const finals = [];
      const partials = [];
      for (const token of response.tokens) {
        const normalized = normalizeToken(token);
        if (normalized.text === '<end>' || normalized.text === '<fin>') continue;
        (token.is_final ? finals : partials).push(normalized);
      }
      const bytes = this.transcriptBytes + finals.reduce((sum, token) => sum + token.text.length * 4, 0);
      if (this.finalTokens.length + finals.length + partials.length > MAX_TOKENS || bytes + partials.reduce((sum, token) => sum + token.text.length * 4, 0) > MAX_TRANSCRIPT_BYTES) {
        throw fail('transcript size limit reached.');
      }
      this.finalTokens.push(...finals);
      this.partialTokens = partials;
      this.transcriptBytes = bytes;
      if (finals.length || partials.length || hadPartial || response.finished === true) {
        this.onTranscript?.({
          finalTokens: [...this.finalTokens], partialTokens: [...this.partialTokens],
          finalText: this.finalTokens.map((token) => token.text).join(''),
          partialText: this.partialTokens.map((token) => token.text).join(''),
        });
      }
      if (response.finished === true) this.complete();
    } catch (error) {
      this.terminate(error instanceof Error && error.message.startsWith('Live transcription ') ? error : fail('received an invalid response.'));
    }
  }

  complete() {
    if (!['active', 'finishing'].includes(this.state)) return;
    const resolve = this.finishResolve;
    this.cleanup();
    this.state = 'closed';
    resolve?.();
    try { this.onFinished?.({ reason: 'finished' }); } catch { /* caller owns callback */ }
  }

  terminate(error, notify = true) {
    if (this.state === 'closed' || this.state === 'idle') return;
    const rejectConnect = this.connectReject;
    const rejectFinish = this.finishReject;
    this.cleanup();
    this.state = 'closed';
    rejectConnect?.(error);
    rejectFinish?.(error);
    if (notify) {
      try { this.onFailure?.(error); } catch { /* caller owns callback */ }
    }
  }

  cleanup() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.finishTimer);
    clearTimeout(this.durationTimer);
    this.connectTimer = this.finishTimer = this.durationTimer = null;
    this.detach?.();
    this.detach = null;
    if (this.socket && this.socket.readyState !== 3) {
      try { this.socket.close(); } catch { /* best effort */ }
    }
    this.socket = null;
    this.connectReject = this.finishResolve = this.finishReject = this.finishPromise = null;
  }
}
