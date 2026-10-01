/**
 * Test Intent:
 * - Verify local recording never requests a paid session and preserves bounded audio.
 * - Verify live audio reaches the stream in order before graceful finalization.
 * - Verify timeout, cancellation, provider failure, and fresh-session isolation via public callbacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingSession } from './recordingSession.js';

const recorders = [];
const streams = [];
class FakeRecorder extends EventTarget {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options) { super(); this.stream = stream; this.options = options; this.state = 'inactive'; recorders.push(this); }
  start(slice) { this.slice = slice; this.state = 'recording'; }
  emit(blob) { this.dispatchEvent(new MessageEvent('dataavailable', { data: blob })); }
  stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.emit(new Blob(['tail'])); this.dispatchEvent(new Event('stop')); }
}
class FakeStream {
  constructor(callbacks) { this.callbacks = callbacks; this.sent = []; streams.push(this); }
  async connect(config) { this.config = config; }
  sendAudio(blob) { this.sent.push(blob); }
  async finish() { this.sent.push('EOF'); }
  cancel() { this.cancelled = true; }
}
function media() {
  const track = { stop: vi.fn() };
  return { track, devices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } };
}
function setup(options = {}) {
  const { track, devices } = media();
  const onAudio = vi.fn();
  const onStage = vi.fn();
  const onFailure = vi.fn();
  const onTranscript = vi.fn();
  const requestSession = vi.fn(async () => ({ api_key: 'temporary', expires_at: new Date(Date.now() + 60000).toISOString(), session_id: 'test-session', max_session_seconds: 60 }));
  const session = new RecordingSession({ onAudio, onStage, onFailure, onTranscript, requestSession, mediaDevices: devices, MediaRecorderClass: FakeRecorder, StreamClass: FakeStream, ...options });
  return { session, onAudio, onStage, onFailure, onTranscript, requestSession, track, devices };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); recorders.length = 0; streams.length = 0; });

const readBlob = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

describe('RecordingSession', () => {
  it('records locally with no session request and returns complete audio', async () => {
    const { session, requestSession, onAudio, onStage, track } = setup();
    await session.start();
    expect(requestSession).not.toHaveBeenCalled();
    expect(recorders[0].slice).toBe(250);
    expect(recorders[0].options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    recorders[0].emit(new Blob(['first']));
    await session.stop();
    expect(await readBlob(onAudio.mock.lastCall[0].blob)).toBe('firsttail');
    expect(onAudio.mock.lastCall[0].complete).toBe(true);
    expect(onStage.mock.lastCall[0].stage).toBe('stopped');
    expect(track.stop).toHaveBeenCalled();
  });

  it('streams every chunk including final recorder chunk before EOF', async () => {
    const { session, requestSession, onAudio } = setup();
    await session.start({ transcribe: true, maxSessionSeconds: 50 });
    expect(requestSession).toHaveBeenCalledOnce();
    expect(streams[0].config.apiKey).toBe('temporary');
    recorders[0].emit(new Blob(['body']));
    await session.stop();
    expect(streams[0].sent.map((part) => typeof part === 'string' ? part : part.size)).toEqual([4, 4, 'EOF']);
    expect(onAudio.mock.lastCall[0].complete).toBe(true);
  });

  it('stops a microphone granted after cancellation', async () => {
    let grant;
    const { session, track, devices } = setup();
    devices.getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const starting = session.start();
    await Promise.resolve();
    session.cancel();
    await expect(starting).rejects.toThrow(/canceled/i);
    grant({ getTracks: () => [track] });
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  });

  it('times out microphone permission and stops a late grant', async () => {
    vi.useFakeTimers();
    let grant;
    const { session, track, devices, onFailure } = setup();
    devices.getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const starting = session.start();
    const assertion = expect(starting).rejects.toThrow(/microphone timed out/i);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    grant({ getTracks: () => [track] });
    await vi.advanceTimersByTimeAsync(1);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight authorization and ignores its late response', async () => {
    let respond;
    const { session, requestSession, track, onAudio } = setup();
    requestSession.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const starting = session.start({ transcribe: true });
    await vi.waitFor(() => expect(requestSession).toHaveBeenCalledOnce());
    session.cancel();
    await expect(starting).rejects.toThrow(/canceled/i);
    respond({ api_key: 'late', expires_at: new Date(Date.now() + 60000).toISOString(), session_id: 'late', max_session_seconds: 60 });
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(streams).toHaveLength(0);
    expect(onAudio).not.toHaveBeenCalled();
  });

  it('keeps local audio and halts capture after a provider failure', async () => {
    const { session, onAudio, onFailure, track } = setup();
    await session.start({ transcribe: true });
    recorders[0].emit(new Blob(['private']));
    streams[0].callbacks.onFailure(new Error('provider leaked private words'));
    await vi.waitFor(() => expect(onAudio).toHaveBeenCalledOnce());
    expect(await readBlob(onAudio.mock.lastCall[0].blob)).toContain('private');
    expect(onAudio.mock.lastCall[0].complete).toBe(false);
    expect(onFailure.mock.lastCall[0].message).not.toContain('private words');
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops at byte cap and avoids storing the over-limit chunk', async () => {
    const { session, onAudio } = setup();
    await session.start();
    recorders[0].emit(new Blob([new Uint8Array(2097152)]));
    recorders[0].emit(new Blob(['extra']));
    await vi.waitFor(() => expect(onAudio).toHaveBeenCalledOnce());
    expect(onAudio.mock.lastCall[0].blob.size).toBe(2097152);
    expect(onAudio.mock.lastCall[0].complete).toBe(false);
  });

  it('is idempotent on stop and isolates old callbacks from a new session', async () => {
    const { session, onAudio, onTranscript } = setup();
    await session.start({ transcribe: true });
    const old = streams[0];
    const first = session.stop();
    expect(session.stop()).toBe(first);
    await first;
    await session.start({ transcribe: true });
    old.callbacks.onTranscript({ finalText: 'stale' });
    expect(onTranscript).not.toHaveBeenCalled();
    session.cancel();
    expect(onAudio).toHaveBeenCalledTimes(1);
  });

  it('cancels connection setup and discards a late connection result', async () => {
    let connect;
    class PendingStream extends FakeStream {
      connect(config) { this.config = config; return new Promise((resolve) => { connect = resolve; }); }
    }
    const { session, onStage, onAudio } = setup({ StreamClass: PendingStream });
    const starting = session.start({ transcribe: true });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    session.cancel();
    await expect(starting).rejects.toThrow(/canceled/i);
    connect();
    await Promise.resolve();
    expect(recorders).toHaveLength(0);
    expect(streams[0].cancelled).toBe(true);
    expect(onStage.mock.lastCall[0].stage).toBe('cancelled');
    expect(onAudio).not.toHaveBeenCalled();
  });

  it('cancels finalization and preserves captured audio without late stage changes', async () => {
    let finish;
    class PendingFinishStream extends FakeStream {
      finish() { this.sent.push('EOF'); return new Promise((resolve) => { finish = resolve; }); }
    }
    const { session, onStage, onAudio } = setup({ StreamClass: PendingFinishStream });
    await session.start({ transcribe: true });
    recorders[0].emit(new Blob(['body']));
    const stopping = session.stop();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    session.cancel();
    await stopping;
    finish();
    expect(onAudio.mock.lastCall[0].blob.size).toBeGreaterThan(0);
    expect(onStage.mock.lastCall[0].stage).toBe('cancelled');
  });

  it('requests a bounded same-origin ephemeral session with explicit consent', async () => {
    const payload = { api_key: 'temporary', expires_at: new Date(Date.now() + 60000).toISOString(), session_id: 'id', max_session_seconds: 15 };
    const fetcher = vi.fn(async () => ({ ok: true, status: 201, text: async () => JSON.stringify(payload) }));
    vi.stubGlobal('fetch', fetcher);
    const { session } = setup({ requestSession: undefined });
    await session.start({ transcribe: true });
    expect(fetcher).toHaveBeenCalledWith('/api/cloud/soniox/session', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { 'X-LCT-Soniox-Consent': 'transcribe-v1' },
    }));
    expect(fetcher.mock.lastCall[1]).not.toHaveProperty('body');
    session.cancel();
  });

  it('cuts live capture five seconds before the requested duration', async () => {
    vi.useFakeTimers();
    const { session, onAudio, track } = setup();
    await session.start({ transcribe: true, maxSessionSeconds: 6 });
    recorders[0].emit(new Blob(['body']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(track.stop).toHaveBeenCalled();
    expect(onAudio).toHaveBeenCalledOnce();
  });

  it('bounds authorization to ten seconds and stops the microphone', async () => {
    vi.useFakeTimers();
    const { session, requestSession, track, onFailure } = setup();
    requestSession.mockImplementation(() => new Promise(() => {}));
    const starting = session.start({ transcribe: true });
    const assertion = expect(starting).rejects.toThrow(/authorization timed out/i);
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(track.stop).toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('marks audio incomplete when recorder stop never acknowledges', async () => {
    vi.useFakeTimers();
    class SilentRecorder extends FakeRecorder {
      stop() { this.state = 'inactive'; }
    }
    const { session, onAudio, track } = setup({ MediaRecorderClass: SilentRecorder });
    await session.start();
    recorders[0].emit(new Blob(['body']));
    const stopping = session.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await stopping;
    expect(onAudio.mock.lastCall[0].complete).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });
});
