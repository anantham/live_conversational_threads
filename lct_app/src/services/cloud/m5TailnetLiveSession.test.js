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
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('reports the open microphone for a level display, and reports it closed on stop and on cancel', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ segments: [] })));
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
