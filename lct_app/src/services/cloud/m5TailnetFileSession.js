// Test intent:
// - Posts audio files directly from the browser to the owner's HTTPS *.ts.net M5 STT server
//   with diarization enabled and parses timed speaker segments into canonical finalTokens.
// - Rejects non-HTTPS or non-tailnet URLs.
// - Marks network/unreachable errors with canTryNext=true so Sites falls back cleanly to Soniox
//   when the browser is off-tailnet.
// - Checks /health before uploading, so an unreachable or blocked server fails in seconds
//   and nothing is sent to it.
// - Allows a wait scaled to the audio's length, publishes the deadline with the stage, and
//   names the reason it stopped: health check, timeout, dropped connection, bad reply, skipped.

import { importAudioSeconds, importFileType } from './audioImportFile.js';

export const DEFAULT_M5_TAILNET_URL = 'https://adityas-macbook-pro.tail4741ad.ts.net:5443/v1/audio/transcriptions';

export function isAllowedTailnetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      parsed.hostname.toLowerCase().endsWith('.ts.net')
    );
  } catch {
    return false;
  }
}

export const M5_DEFAULT_LIMIT_MS = 180_000;

/**
 * How long to wait for one file. The M5 transcribes with speaker labels at roughly 30x
 * real time (an hour of audio in about two minutes), so allow a minute to get going plus
 * a tenth of the audio's length, capped at 15 minutes. Unknown length keeps 3 minutes.
 */
export function m5TranscriptionLimitMs(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return M5_DEFAULT_LIMIT_MS;
  return Math.round(Math.min(900, 60 + seconds / 10) * 1000);
}

function m5Failure(reason, message, cause) {
  const failure = new Error(message);
  failure.reason = reason;
  failure.canTryNext = true;
  if (cause) failure.cause = cause;
  return failure;
}

function healthFailure(health) {
  if (health.status === 'timeout') {
    return m5Failure('health_timeout', 'M5 Tailnet STT did not answer its health check. Your audio was not sent to it.');
  }
  if (health.status === 'http_error') {
    return m5Failure('health_http', health.httpStatus === 503
      ? 'M5 Tailnet STT is still loading its models. Your audio was not sent to it.'
      : `M5 Tailnet STT health check returned HTTP ${health.httpStatus}. Your audio was not sent to it.`);
  }
  return m5Failure('unreachable',
    'M5 Tailnet STT did not answer this browser. Connect to Tailscale, or check that the M5 server allows this site (CORS). Your audio was not sent to it.');
}

export async function probeM5TailnetEndpoint(url = DEFAULT_M5_TAILNET_URL, { token = '', timeoutMs = 8000, signal } = {}) {
  const trimmed = typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_M5_TAILNET_URL;
  if (!isAllowedTailnetUrl(trimmed)) {
    return { ok: false, status: 'invalid', message: 'Enter an HTTPS *.ts.net endpoint URL.' };
  }
  const healthUrl = new URL('/health', new URL(trimmed).origin).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) relay();
  const startedAt = Date.now();
  try {
    const headers = typeof token === 'string' && token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {};
    const response = await fetch(healthUrl, { method: 'GET', headers, signal: controller.signal });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (!response.ok) {
      return {
        ok: false,
        status: 'http_error',
        httpStatus: response.status,
        latencyMs,
        message: `M5 endpoint responded with HTTP ${response.status} (${latencyMs} ms).`,
      };
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const details = [
      payload?.engine,
      payload?.model,
      payload?.diarization ? `diarization: ${payload.diarization}` : '',
    ].filter(Boolean);
    return {
      ok: true,
      status: 'ready',
      latencyMs,
      engine: payload?.engine || '',
      model: payload?.model || '',
      diarization: payload?.diarization || '',
      message: details.length
        ? `Connected in ${latencyMs} ms · ${details.join(' · ')}`
        : `Connected in ${latencyMs} ms.`,
    };
  } catch (error) {
    if (signal?.aborted) return { ok: false, status: 'cancelled', message: 'Stopped.' };
    if (error?.name === 'AbortError') {
      return {
        ok: false,
        status: 'timeout',
        message: 'Timed out waiting for M5 Tailnet STT. Check that Tailscale is connected and the server is running.',
      };
    }
    return {
      ok: false,
      status: 'unreachable',
      message: 'Could not reach M5 Tailnet STT from this browser. Check Tailscale connection and CORS headers on the M5 server.',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

export function parseM5Segments(payload) {
  const rawSegments = Array.isArray(payload?.segments) ? payload.segments : [];
  const timed = rawSegments
    .filter(row => row && typeof row.text === 'string' && row.text.trim())
    .map((row, index) => {
      const start = Number.isFinite(Number(row.start)) && Number(row.start) >= 0 ? Number(row.start) : 0;
      const end = Number.isFinite(Number(row.end)) && Number(row.end) >= start ? Number(row.end) : start;
      const speaker = String(row.speaker || row.speaker_id || row.speaker_label || 'Speaker 1').trim() || 'Speaker 1';
      return {
        text: (index ? '\n' : '') + row.text.trim(),
        speaker,
        startMs: Math.round(start * 1000),
        endMs: Math.round(end * 1000),
      };
    });
  if (timed.length) return timed;
  const fallbackText = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!fallbackText) return [];
  return [{ text: fallbackText, speaker: 'Speaker 1', startMs: 0, endMs: 0 }];
}

export class M5TailnetFileSession {
  constructor({ url = DEFAULT_M5_TAILNET_URL, token = '', diarize = true, onStage, onAudio, onTranscript,
    readSeconds = importAudioSeconds } = {}) {
    Object.assign(this, {
      url: isAllowedTailnetUrl(url) ? url.trim() : DEFAULT_M5_TAILNET_URL,
      token: typeof token === 'string' ? token.trim() : '',
      diarize,
      onStage,
      onAudio,
      onTranscript,
      readSeconds,
    });
    this.controller = new AbortController();
    this.skipped = false;
  }

  /** Why this.controller was aborted: the user stopped the import, or asked for the next provider. */
  stopped() {
    return this.skipped ? m5Failure('skipped', 'Skipped M5 Tailnet STT.') : new DOMException('Aborted', 'AbortError');
  }

  async start({ file }) {
    const signal = this.controller.signal;
    const mimeType = importFileType(file);
    const upload = file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
    this.onAudio?.({
      blob: upload,
      mimeType,
      complete: true,
      segments: [{ number: 1, blob: upload, mimeType, complete: true }],
    });
    try {
      this.onStage?.({ stage: 'connecting', message: 'Checking M5 Tailnet STT.', startedAt: Date.now() });
      const health = await probeM5TailnetEndpoint(this.url, { token: this.token, signal });
      if (signal.aborted) throw this.stopped();
      if (!health.ok) throw healthFailure(health);

      const limitMs = m5TranscriptionLimitMs(await this.readSeconds(upload, { signal }));
      if (signal.aborted) throw this.stopped();
      const startedAt = Date.now();
      this.onStage?.({ stage: 'transcribing', message: 'Transcribing your audio on M5 Tailnet STT.',
        startedAt, deadlineAt: startedAt + limitMs, skippable: true });

      const form = new FormData();
      form.append('file', upload, upload.name || 'audio.wav');
      form.append('response_format', 'verbose_json');
      if (this.diarize) form.append('diarize', 'true');
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      // One request controller, so the deadline covers the reply body as well as the upload.
      const request = new AbortController();
      const relay = () => request.abort();
      signal.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; request.abort(); }, limitMs);
      let response, payload;
      try {
        response = await fetch(this.url, { method: 'POST', body: form, headers, signal: request.signal });
        if (response.ok) payload = await response.json();
      } catch (cause) {
        if (signal.aborted) throw this.stopped();
        if (timedOut) {
          throw m5Failure('timeout',
            `M5 Tailnet STT did not finish within ${Math.round(limitMs / 1000)} s. It may be busy. Your original audio is preserved.`, cause);
        }
        if (cause instanceof SyntaxError) {
          throw m5Failure('bad_reply', 'M5 Tailnet STT sent a reply that could not be read. Your original audio is preserved.', cause);
        }
        throw m5Failure('dropped',
          'The connection to M5 Tailnet STT dropped, or the browser blocked its reply (CORS). Your original audio is preserved.', cause);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
      }
      if (signal.aborted) throw this.stopped();
      if (!response.ok) {
        const err = new Error(`M5 Tailnet STT returned HTTP ${response.status}. Your original audio is preserved.`);
        err.reason = 'http';
        if (response.status >= 500 || response.status === 404 || response.status === 401 || response.status === 403) {
          err.canTryNext = true;
        }
        throw err;
      }
      const finalTokens = parseM5Segments(payload);
      if (!finalTokens.length) throw new Error('M5 Tailnet STT returned no usable speech passages. Your original audio is preserved.');
      const transcript = {
        finalTokens,
        finalText: finalTokens.map(token => token.text).join(''),
        partialText: '',
        partialTokens: [],
      };
      this.onTranscript?.(transcript);
      this.onStage?.({ stage: 'stopped', message: 'Transcript ready (M5 Tailnet).', startedAt: Date.now() });
      return transcript;
    } catch (error) {
      if (!signal.aborted) this.onStage?.({ stage: 'error', message: error.message, startedAt: Date.now() });
      throw error;
    } finally {
      this.controller.abort();
    }
  }

  /** Give up on this provider and let the import move to the next one. */
  skip() {
    if (this.controller.signal.aborted) return;
    this.skipped = true;
    this.controller.abort();
  }

  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.onStage?.({ stage: 'cancelled', message: 'Import stopped. Your original audio is preserved.', startedAt: Date.now() });
  }
}
