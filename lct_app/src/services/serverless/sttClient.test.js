import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transcribeAudio } from './sttClient';
import { NeedsKeyError, startTrial } from './serverlessAuth';

// Pins the Blob-free transport architecture (2026-07-06): BYOK audio goes
// STRAIGHT to api.openai.com (the browser holds the key; OpenAI allows
// browser CORS), and only the trial path hops through /api/proxy/transcribe
// as a raw body (the owner key lives server-side). The old Vercel-Blob
// detour is gone — a regression back to it would change these URLs.

const DIARIZED_RESPONSE = {
  text: 'hello world',
  duration: 2.5,
  segments: [{ speaker: 'A', start: 0, end: 2.5, text: 'hello world' }],
};

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => DIARIZED_RESPONSE,
  });
}

describe('transcribeAudio transport selection', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = mockFetchOk();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('BYOK posts multipart directly to api.openai.com with the bearer key', async () => {
    const file = new File(['x'.repeat(64)], 'clip.wav', { type: 'audio/wav' });
    const result = await transcribeAudio('sk-user-key', file);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer sk-user-key');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe('gpt-4o-transcribe-diarize');
    expect(init.body.get('response_format')).toBe('diarized_json');
    expect(init.body.get('chunking_strategy')).toBe('auto');
    expect(result.text).toBe('hello world');
    expect(result.segments[0].speaker).toBe('A');
  });

  it('trial posts the raw body to the proxy with x-lct-trial and query params', async () => {
    startTrial();
    const file = new File(['x'.repeat(64)], 'clip.webm', { type: 'audio/webm' });
    await transcribeAudio('', file);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/proxy/transcribe?');
    expect(url).toContain('model=gpt-4o-transcribe-diarize');
    expect(url).toContain('filename=clip.webm');
    // Real MIME rides the query; the transport Content-Type is pinned to
    // octet-stream so Vercel's Node helper reliably buffers the body.
    expect(url).toContain('mimetype=audio%2Fwebm');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers['x-lct-trial']).toBe('1');
    expect(init.headers['x-lct-byok-key']).toBeUndefined();
    expect(init.body).toBe(file); // raw body, not FormData, not Blob-upload
  });

  it('BYOK maps a 401 from OpenAI to NeedsKeyError (bad key re-opens the gate)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    const file = new File(['x'], 'clip.wav', { type: 'audio/wav' });
    await expect(transcribeAudio('sk-revoked', file)).rejects.toBeInstanceOf(NeedsKeyError);
  });

  it('BYOK rejects files over the OpenAI 25MB limit before fetching', async () => {
    const big = new File([new ArrayBuffer(26 * 1024 * 1024)], 'huge.wav', { type: 'audio/wav' });
    await expect(transcribeAudio('sk-user-key', big)).rejects.toThrow(/25MB/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('trial rejects files over the function body limit with a clear message', async () => {
    startTrial();
    const big = new File([new ArrayBuffer(5 * 1024 * 1024)], 'big.wav', { type: 'audio/wav' });
    await expect(transcribeAudio('', big)).rejects.toThrow(/too large for the free trial/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws NeedsKeyError with no key and no active trial', async () => {
    const file = new File(['x'], 'clip.wav', { type: 'audio/wav' });
    await expect(transcribeAudio('', file)).rejects.toBeInstanceOf(NeedsKeyError);
  });

  it('maps a 402 from the proxy to NeedsKeyError (trial exhausted)', async () => {
    startTrial();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({}) });
    const file = new File(['x'], 'clip.wav', { type: 'audio/wav' });
    await expect(transcribeAudio('', file)).rejects.toBeInstanceOf(NeedsKeyError);
  });
});
