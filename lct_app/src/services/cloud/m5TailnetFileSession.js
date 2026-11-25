// Test intent:
// - Posts audio files directly from the browser to the owner's HTTPS *.ts.net M5 STT server
//   with diarization enabled and parses timed speaker segments into canonical finalTokens.
// - Rejects non-HTTPS or non-tailnet URLs.
// - Marks network/unreachable errors with canTryNext=true so Sites falls back cleanly to Soniox
//   when the browser is off-tailnet.

import { importFileType, importWait } from './audioImportFile.js';

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
  constructor({ url = DEFAULT_M5_TAILNET_URL, token = '', diarize = true, onStage, onAudio, onTranscript } = {}) {
    Object.assign(this, {
      url: isAllowedTailnetUrl(url) ? url.trim() : DEFAULT_M5_TAILNET_URL,
      token: typeof token === 'string' ? token.trim() : '',
      diarize,
      onStage,
      onAudio,
      onTranscript,
    });
    this.controller = new AbortController();
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
    this.onStage?.({ stage: 'transcribing', message: 'Transcribing your audio on M5 Tailnet STT.', startedAt: Date.now() });
    try {
      const form = new FormData();
      form.append('file', upload, upload.name || 'audio.wav');
      form.append('response_format', 'verbose_json');
      if (this.diarize) form.append('diarize', 'true');
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      let response;
      try {
        response = await importWait(
          fetch(this.url, { method: 'POST', body: form, headers, signal }),
          signal,
          180_000,
        );
      } catch (networkErr) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const err = new Error('M5 Tailnet STT could not be reached. Connect to Tailscale or use a fallback provider.');
        err.canTryNext = true;
        err.cause = networkErr;
        throw err;
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!response.ok) {
        const err = new Error(`M5 Tailnet STT returned HTTP ${response.status}. Your original audio is preserved.`);
        if (response.status >= 500 || response.status === 404 || response.status === 401 || response.status === 403) {
          err.canTryNext = true;
        }
        throw err;
      }
      const payload = await response.json();
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

  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.onStage?.({ stage: 'cancelled', message: 'Import stopped. Your original audio is preserved.', startedAt: Date.now() });
  }
}
