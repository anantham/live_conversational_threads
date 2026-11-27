// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_M5_TAILNET_URL,
  isAllowedTailnetUrl,
  M5TailnetFileSession,
  m5TranscriptionLimitMs,
  parseM5Segments,
  probeM5TailnetEndpoint,
} from './m5TailnetFileSession.js';

describe('m5TailnetFileSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows only HTTPS credential-free *.ts.net URLs', () => {
    expect(isAllowedTailnetUrl(DEFAULT_M5_TAILNET_URL)).toBe(true);
    expect(isAllowedTailnetUrl('http://adityas-macbook-pro.tail4741ad.ts.net:5443/v1/audio/transcriptions')).toBe(false);
    expect(isAllowedTailnetUrl('https://evil.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isAllowedTailnetUrl('https://user:pass@adityas-macbook-pro.tail4741ad.ts.net/v1')).toBe(false);
  });

  it('parses diarized M5 segments into timed finalTokens', () => {
    const tokens = parseM5Segments({
      segments: [
        { start: 0.5, end: 3.2, speaker: 'SPEAKER_00', text: 'First turn.' },
        { start: 3.5, end: 6.0, speaker: 'SPEAKER_01', text: 'Second turn.' },
      ],
    });
    expect(tokens).toEqual([
      { text: 'First turn.', speaker: 'SPEAKER_00', startMs: 500, endMs: 3200 },
      { text: '\nSecond turn.', speaker: 'SPEAKER_01', startMs: 3500, endMs: 6000 },
    ]);
  });

  it('marks unreachable M5 tailnet errors with canTryNext=true so Sites falls back to Soniox', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const stages = [];
    const session = new M5TailnetFileSession({
      onStage: s => stages.push(s.stage),
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'sample.wav', { type: 'audio/wav' });
    let caught;
    try {
      await session.start({ file });
    } catch (err) {
      caught = err;
    }
    expect(caught?.canTryNext).toBe(true);
    expect(caught?.message).toContain('Tailscale');
    expect(stages).toContain('error');
  });

  it('probes /health on the tailnet origin and reports engine, model, and CORS/network errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        engine: 'fluidaudio-parakeet',
        model: 'parakeet-tdt-0.6b-v3',
        diarization: 'ready',
        status: 'healthy',
      }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await probeM5TailnetEndpoint(DEFAULT_M5_TAILNET_URL);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('fluidaudio-parakeet');
    expect(ok.message).toContain('diarization: ready');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://adityas-macbook-pro.tail4741ad.ts.net:5443/health',
      expect.objectContaining({ method: 'GET' }),
    );

    const err = await probeM5TailnetEndpoint(DEFAULT_M5_TAILNET_URL);
    expect(err.ok).toBe(false);
    expect(err.status).toBe('unreachable');
    expect(err.message).toContain('CORS');

    const bad = await probeM5TailnetEndpoint('https://evil.example.com/v1/audio/transcriptions');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe('invalid');
  });

  it('allows a wait scaled to the audio length, between one and fifteen minutes', () => {
    expect(m5TranscriptionLimitMs(null)).toBe(180_000);
    expect(m5TranscriptionLimitMs(30)).toBe(63_000);
    expect(m5TranscriptionLimitMs(300)).toBe(90_000);
    expect(m5TranscriptionLimitMs(3600)).toBe(420_000);
    expect(m5TranscriptionLimitMs(36_000)).toBe(900_000);
  });

  it('sends no audio when the health check fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('loading', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const session = new M5TailnetFileSession({ readSeconds: async () => 60 });
    const failure = await session.start({ file: new File([new Uint8Array([1])], 'a.wav', { type: 'audio/wav' }) }).catch(e => e);
    expect(failure.reason).toBe('health_http');
    expect(failure.canTryNext).toBe(true);
    expect(failure.message).toContain('still loading');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://adityas-macbook-pro.tail4741ad.ts.net:5443/health');
  });

  it('publishes its deadline, stops the upload when it passes, and reports a timeout', async () => {
    vi.useFakeTimers();
    try {
      let uploadSignal;
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({ status: 'healthy' }))
        .mockImplementationOnce((url, options) => new Promise((resolve, reject) => {
          uploadSignal = options.signal;
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })));
      const stages = [];
      const session = new M5TailnetFileSession({ onStage: stage => stages.push(stage), readSeconds: async () => 300 });
      const outcome = session.start({ file: new File([new Uint8Array([1])], 'a.wav', { type: 'audio/wav' }) }).catch(e => e);
      await vi.advanceTimersByTimeAsync(89_000);
      expect(uploadSignal.aborted).toBe(false);
      const working = stages.find(stage => stage.stage === 'transcribing');
      expect(working.deadlineAt - working.startedAt).toBe(90_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const failure = await outcome;
      expect(uploadSignal.aborted).toBe(true);
      expect(failure.reason).toBe('timeout');
      expect(failure.canTryNext).toBe(true);
      expect(failure.message).toContain('did not finish within 90 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a dropped or blocked reply apart from a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'healthy' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const session = new M5TailnetFileSession({ readSeconds: async () => 60 });
    const failure = await session.start({ file: new File([new Uint8Array([1])], 'a.wav', { type: 'audio/wav' }) }).catch(e => e);
    expect(failure.reason).toBe('dropped');
    expect(failure.message).toContain('blocked its reply');
  });

  // Review fixes, 2026-11-27: fail closed on the address and on what answers at it.
  const wav = () => new File([new Uint8Array([1])], 'a.wav', { type: 'audio/wav' });
  const healthy = () => Response.json({ engine: 'fluidaudio-parakeet', status: 'healthy' });

  it('requires a node and a tailnet label before .ts.net', () => {
    expect(isAllowedTailnetUrl('https://node.tailnet.ts.net:5443/v1/audio/transcriptions')).toBe(true);
    expect(isAllowedTailnetUrl('https://.ts.net/v1')).toBe(false);
    expect(isAllowedTailnetUrl('https://ts.net/v1')).toBe(false);
    expect(isAllowedTailnetUrl('https://tailnet.ts.net/v1')).toBe(false);
    expect(isAllowedTailnetUrl('https://node.tailnet.ts.net.attacker.example/v1')).toBe(false);
  });

  it('does not take an HTTP 200 page for the speech server, and sends it no audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    const probe = await probeM5TailnetEndpoint(DEFAULT_M5_TAILNET_URL);
    expect(probe).toMatchObject({ ok: false, status: 'bad_reply' });
    const failure = await new M5TailnetFileSession({ readSeconds: async () => 60 }).start({ file: wav() }).catch(e => e);
    expect(failure.reason).toBe('health_bad_reply');
    expect(failure.canTryNext).toBe(true);
    expect(failure.message).toContain('Your audio was not sent');
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('reports a health reply that runs out of time while its body arrives as a timeout, not as ready', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((url, init) => Promise.resolve({ ok: true, status: 200,
        json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) })));
      const pending = probeM5TailnetEndpoint(DEFAULT_M5_TAILNET_URL, { timeoutMs: 8000 });
      await vi.advanceTimersByTimeAsync(8001);
      expect(await pending).toMatchObject({ ok: false, status: 'timeout' });
    } finally { vi.useRealTimers(); }
  });

  it('refuses redirects on the health check and on the upload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(healthy())
      .mockResolvedValueOnce(Response.json({ segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', text: 'Hello.' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await new M5TailnetFileSession({ readSeconds: async () => 60 }).start({ file: wav() });
    expect(fetchMock.mock.calls.map(([, init]) => init.redirect)).toEqual(['error', 'error']);
  });

  it('refuses a filled-in address that is not allowed instead of quietly using the default host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = new M5TailnetFileSession({ url: 'http://node.tailnet.ts.net:5443/v1/audio/transcriptions', token: 'synthetic-token', readSeconds: async () => 60 });
    const failure = await session.start({ file: wav() }).catch(e => e);
    expect(failure.reason).toBe('invalid_url');
    expect(failure.canTryNext).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // An empty address still means the default.
    expect(new M5TailnetFileSession({ url: '  ' }).url).toBe(DEFAULT_M5_TAILNET_URL);
  });

  it('treats a skip that lands while the audio length is being read as a skip, so the next provider runs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(healthy());
    vi.stubGlobal('fetch', fetchMock);
    let session;
    const stages = [];
    session = new M5TailnetFileSession({ onStage: stage => stages.push(stage.stage),
      readSeconds: (file, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        queueMicrotask(() => session.skip());
      }) });
    const failure = await session.start({ file: wav() }).catch(e => e);
    expect(failure.reason).toBe('skipped');
    expect(failure.canTryNext).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stages).not.toContain('error');
  });

  it('lets the next provider try after "too large", "unsupported" and "busy" refusals, but not after a malformed request', async () => {
    for (const [status, canTryNext] of [[413, true], [415, true], [429, true], [408, true], [400, undefined]]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(healthy()).mockResolvedValueOnce(new Response('no', { status })));
      const failure = await new M5TailnetFileSession({ readSeconds: async () => 60 }).start({ file: wav() }).catch(e => e);
      expect([status, failure.reason, failure.canTryNext]).toEqual([status, 'http', canTryNext]);
    }
  });
});
