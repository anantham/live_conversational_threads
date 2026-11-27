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
});
