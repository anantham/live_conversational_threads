// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M5TailnetLiveSession } from './m5TailnetLiveSession.js';

class FakeMediaRecorder {
  constructor(_stream, opts = {}) {
    this.mimeType = opts.mimeType || 'audio/webm';
    this.state = 'inactive';
  }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) });
    this.onstop?.();
  }
}
FakeMediaRecorder.isTypeSupported = () => true;

describe('M5TailnetLiveSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads recorded audio slices to M5 Tailnet STT and emits transcript + live telemetry', async () => {
    const trackStop = vi.fn();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ engine: 'fluidaudio-parakeet', status: 'healthy' }))
      .mockResolvedValueOnce(Response.json({
        segments: [{ start: 0.2, end: 1.5, speaker: 'SPEAKER_00', text: 'Hello from M5 live.' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const transcripts = [];
    const metrics = [];
    const stages = [];
    const session = new M5TailnetLiveSession({
      sliceMs: 60_000,
      onStage: s => stages.push(s.stage),
      onTranscript: t => transcripts.push(t),
      onMetrics: m => metrics.push(m),
      onAudio: vi.fn(),
      onFailure: vi.fn(),
    });

    await session.start();
    await session.stop();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transcripts.at(-1)?.finalText).toBe('Hello from M5 live.');
    expect(metrics.at(-1)).toMatchObject({
      provider: 'm5_tailnet',
      chunksCompleted: 1,
      costUsd: 0,
    });
    expect(typeof metrics.at(-1)?.ttftMs).toBe('number');
    expect(typeof metrics.at(-1)?.lastLatencyMs).toBe('number');
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(stages).toContain('stopped');
  });

  it('fails fast on /health without opening the microphone when M5 is unreachable', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const onFailure = vi.fn();
    const session = new M5TailnetLiveSession({ onFailure });
    await expect(session.start()).rejects.toThrow(/CORS|Tailscale|reach/i);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('releases the microphone on pause and reopens it on resume', async () => {
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: 'healthy', segments: [] }))));
    const opened = [];
    const session = new M5TailnetLiveSession({ sliceMs: 60_000, onMicStream: value => opened.push(value) });
    await session.start();
    expect(opened).toEqual([stream]);
    await session.pause();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([stream, null]);
    await session.resume();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(opened).toEqual([stream, null, stream]);
    await session.stop();
    expect(opened).toEqual([stream, null, stream, null]);
  });

  it('reports the open microphone for a level display, and reports it closed on stop and on cancel', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: 'healthy', segments: [] }))));
    const opened = [];
    const session = new M5TailnetLiveSession({ sliceMs: 60_000, onMicStream: value => opened.push(value) });
    await session.start();
    expect(opened).toEqual([stream]);
    await session.stop();
    expect(opened).toEqual([stream, null]);

    const cancelled = [];
    const second = new M5TailnetLiveSession({ sliceMs: 60_000, onMicStream: value => cancelled.push(value) });
    await second.start();
    second.cancel();
    expect(cancelled).toEqual([stream, null]);
  });
});

// Review fixes, 2026-11-27 (two Claude Opus reviews of 1f900d2e). Synthetic audio and a fake recorder only.
describe('M5TailnetLiveSession: endings, races and failures', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const healthy = () => Response.json({ engine: 'fluidaudio-parakeet', status: 'healthy' });
  const track = () => ({ stop: vi.fn(), addEventListener: vi.fn() });
  const streamOf = t => ({ getTracks: () => [t], getAudioTracks: () => [t] });
  function setup({ fetchImpl, getUserMedia, url, sliceMs = 60_000, sliceTimeoutMs = 1000 } = {}) {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const tracks = [];
    const gum = getUserMedia || vi.fn(async () => { const t = track(); tracks.push(t); return streamOf(t); });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } });
    const fetchMock = vi.fn(fetchImpl || (async u => String(u).endsWith('/health') ? healthy() : Response.json({ segments: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const events = { stages: [], chunks: [], failures: [], transcripts: [], audio: [] };
    const session = new M5TailnetLiveSession({ url, sliceMs, sliceTimeoutMs,
      onStage: s => events.stages.push(s.stage), onAudioChunk: c => events.chunks.push(c), onFailure: f => events.failures.push(f.message),
      onTranscript: t => events.transcripts.push(t), onAudio: a => events.audio.push(a) });
    return { session, events, fetchMock, gum, tracks };
  }

  it('ends with an error stage when the server cannot be reached, so the page is not left recording', async () => {
    const { session, events, gum } = setup({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(session.start()).rejects.toMatchObject({ canTryNext: true, reason: 'health' });
    expect(events.stages).toEqual(['connecting', 'error']);
    expect(gum).not.toHaveBeenCalled();
    await session.stop(); session.cancel();
    expect(events.stages).toEqual(['connecting', 'error']);
  });

  it('ends with an error stage when the microphone is refused, and does not offer the next provider', async () => {
    const { session, events } = setup({ getUserMedia: vi.fn(async () => { throw new Error('Permission denied'); }) });
    const failure = await session.start().catch(error => error);
    expect(failure).toMatchObject({ reason: 'microphone' });
    expect(failure.canTryNext).toBeUndefined();
    expect(events.stages).toEqual(['connecting', 'microphone', 'error']);
  });

  it('never opens the microphone after Stop during the health check', async () => {
    let release;
    const { session, events, gum } = setup({ fetchImpl: () => new Promise(resolve => { release = () => resolve(healthy()); }) });
    const starting = session.start();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await session.stop(); release(); await starting;
    expect(gum).not.toHaveBeenCalled();
    expect(events.stages).toEqual(['connecting', 'cancelled']);
  });

  it('closes a microphone granted after Stop, and never claims to be recording', async () => {
    let grant;
    const { session, events } = setup({ getUserMedia: vi.fn(() => new Promise(resolve => { grant = resolve; })) });
    const starting = session.start();
    await vi.waitFor(() => expect(grant).toBeTypeOf('function'));
    await session.stop();
    const late = track(); grant(streamOf(late)); await starting;
    expect(late.stop).toHaveBeenCalled();
    expect(events.stages).not.toContain('recording');
  });

  it('opens one microphone when Resume is pressed twice', async () => {
    const { session, gum, tracks } = setup();
    await session.start(); await session.pause();
    await Promise.all([session.resume(), session.resume()]);
    expect(gum).toHaveBeenCalledTimes(2);
    await session.stop();
    expect(tracks.every(t => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it('hands each chunk over with its slice number and index, as the browser store requires', async () => {
    const { session, events } = setup();
    await session.start(); await session.stop();
    expect(events.chunks[0]).toMatchObject({ segment: 1, index: 0, mimeType: expect.any(String) });
    expect(events.chunks[0].blob).toBeInstanceOf(Blob);
  });

  it('gives up on a stalled slice, keeps going, and retries it at Stop', async () => {
    let transcriptionCalls = 0;
    const { session, events } = setup({ sliceTimeoutMs: 30, fetchImpl: (u, init) => {
      if (String(u).endsWith('/health')) return Promise.resolve(healthy());
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      return Promise.resolve(Response.json({ segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', text: 'Recovered.' }] }));
    } });
    await session.start(); await session.stop();
    expect(events.failures[0]).toMatch(/did not answer within/);
    expect(events.transcripts.at(-1).finalText).toBe('Recovered.');
    expect(events.audio.at(-1)).toMatchObject({ complete: true, transcriptGaps: 0 });
    expect(events.stages.at(-1)).toBe('stopped');
  });

  it('reports a part that still fails at Stop as a gap in the transcript', async () => {
    const { session, events } = setup({ fetchImpl: async u => String(u).endsWith('/health') ? healthy() : new Response('busy', { status: 503 }) });
    await session.start(); await session.stop();
    expect(events.audio.at(-1)).toMatchObject({ complete: true, transcriptGaps: 1 });
    expect(events.failures.at(-1)).toMatch(/could not be transcribed/);
  });

  it('refuses an address that is not allowed instead of using the default host', async () => {
    const { session, fetchMock } = setup({ url: 'http://node.tailnet.ts.net:5443/v1/audio/transcriptions' });
    await expect(session.start()).rejects.toMatchObject({ reason: 'health' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('places each slice at its position in the recording and keeps speaker labels to their slice', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let call = 0;
    const replies = [
      { segments: [{ start: 0.5, end: 1, speaker: 'SPEAKER_00', text: 'First.' }] },
      { segments: [{ start: 0.2, end: 0.8, speaker: 'SPEAKER_00', text: 'Second.' }] },
    ];
    const { session, events } = setup({ sliceMs: 6000, fetchImpl: async u => String(u).endsWith('/health') ? healthy() : Response.json(replies[call++]) });
    await session.start();
    await vi.advanceTimersByTimeAsync(6000);
    await session.stop();
    expect(events.transcripts.at(-1).finalTokens.map(({ text, speaker, startMs }) => ({ text, speaker, startMs }))).toEqual([
      { text: 'First.', speaker: 'segment-1:SPEAKER_00', startMs: 500 },
      { text: '\nSecond.', speaker: 'segment-2:SPEAKER_00', startMs: 6200 },
    ]);
  });

  it('leaves a finished recording finished when cancel arrives afterwards', async () => {
    const { session, events } = setup();
    await session.start(); await session.stop(); session.cancel();
    expect(events.stages.at(-1)).toBe('stopped');
  });

  it('ignores a recorder that stops only after the recording has finished, and starts no second recorder', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const started = [];
    class LateRecorder {
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; started.push(this); }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        // The data arrives at once; the stop event only seven seconds later.
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1])], { type: 'audio/webm' }) });
        setTimeout(() => this.onstop?.(), 7000);
      }
    }
    LateRecorder.isTypeSupported = () => true;
    const { session, events } = setup();
    vi.stubGlobal('MediaRecorder', LateRecorder);
    await session.start();
    const stopping = session.stop();
    await vi.advanceTimersByTimeAsync(5100);
    await stopping;
    expect(events.stages.at(-1)).toBe('stopped');
    await vi.advanceTimersByTimeAsync(3000);
    expect(events.audio.filter(audio => audio.complete === false)).toEqual([]);
    expect(started).toHaveLength(1);
  });

  it('does not let a slow stop from before a pause start a second recorder after Resume', async () => {
    vi.useFakeTimers({ now: 3_000_000 });
    const started = [];
    class LateRecorder {
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; started.push(this); }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1])], { type: 'audio/webm' }) });
        setTimeout(() => this.onstop?.(), 7000);
      }
    }
    LateRecorder.isTypeSupported = () => true;
    const { session } = setup();
    vi.stubGlobal('MediaRecorder', LateRecorder);
    await session.start();
    const pausing = session.pause();
    await vi.advanceTimersByTimeAsync(5100);
    await pausing;
    await session.resume();
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000); // the first recorder's stop event arrives now
    expect(started).toHaveLength(2);
    session.cancel();
  });

  it('marks a slice failure as recoverable, since the slice is retried at Stop', async () => {
    const failures = [];
    const { session } = setup({ fetchImpl: async u => String(u).endsWith('/health') ? healthy() : new Response('busy', { status: 503 }) });
    session.onFailure = failure => failures.push(failure);
    await session.start(); await session.stop();
    expect(failures[0].recoverable).toBe(true);
    expect(failures.at(-1).recoverable).toBeUndefined(); // the gap report at the end is not recoverable
  });
});
