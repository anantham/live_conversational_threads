/**
 * Test Intent:
 * - Exercise the public live-stream lifecycle through a fake WebSocket without network calls.
 * - Verify stable and provisional transcript output, graceful completion, and bounded sends.
 * - Verify timeout, abort, provider failure, and stale-session cleanup through observable callbacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SonioxStream } from './sonioxStream.js';

class FakeSocket extends EventTarget {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  raw(value) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close')); }
}

afterEach(() => { vi.useRealTimers(); FakeSocket.instances = []; });

async function connected(options = {}) {
  const onTranscript = vi.fn();
  const onFailure = vi.fn();
  const onFinished = vi.fn();
  const stream = new SonioxStream({ onTranscript, onFailure, onFinished, WebSocketClass: FakeSocket });
  const promise = stream.connect({ apiKey: 'secret-test-key', expiresAt: new Date(Date.now() + 60000).toISOString(), maxSessionSeconds: 60, ...options });
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  await promise;
  return { stream, socket, onTranscript, onFailure, onFinished };
}

describe('SonioxStream', () => {
  it('configures the fixed STT endpoint and sends bounded binary audio then EOF', async () => {
    const { stream, socket, onFinished } = await connected();
    expect(socket.url).toBe('wss://stt-rt.soniox.com/transcribe-websocket');
    expect(JSON.parse(socket.sent[0])).toEqual({ api_key: 'secret-test-key', model: 'stt-rt-v5', audio_format: 'auto', enable_speaker_diarization: true, enable_endpoint_detection: true });
    stream.sendAudio(new Uint8Array([1, 2]).buffer);
    expect(socket.sent[1]).toBeInstanceOf(ArrayBuffer);
    const finish = stream.finish();
    expect(socket.sent.at(-1)).toBe('');
    let settled = false;
    finish.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive({ tokens: [], finished: true });
    await finish;
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('appends final tokens once, replaces provisional suffix and omits marker tokens', async () => {
    const { socket, onTranscript } = await connected();
    socket.receive({ tokens: [{ text: 'Hi', is_final: false }] });
    socket.receive({ tokens: [{ text: 'Hello', is_final: true, start_ms: 0, end_ms: 240, speaker: '1' }, { text: ' there', is_final: false }] });
    socket.receive({ tokens: [{ text: ' there', is_final: true }, { text: '<end>', is_final: true }, { text: '<fin>', is_final: true }] });
    expect(onTranscript.mock.lastCall[0]).toEqual({ finalTokens: [{ text: 'Hello', speaker: '1', startMs: 0, endMs: 240 }, { text: ' there', speaker: null, startMs: null, endMs: null }], partialTokens: [], finalText: 'Hello there', partialText: '' });
  });

  it('clears a withdrawn provisional suffix and accepts the bounded issuer key shape', async () => {
    const { socket, stream, onTranscript } = await connected({ apiKey: 'snx_temp_' + 'x'.repeat(512) });
    socket.receive({ tokens: [{ text: 'tentative', is_final: false }] });
    socket.receive({ tokens: [] });
    expect(onTranscript.mock.lastCall[0]).toMatchObject({ finalText: '', partialText: '', partialTokens: [] });
    stream.cancel();
  });

  it('rejects oversized frames and backpressure before sending', async () => {
    const { stream, socket } = await connected();
    expect(() => stream.sendAudio(new ArrayBuffer(262145))).toThrow(/audio frame/i);
    socket.bufferedAmount = 1048576;
    expect(() => stream.sendAudio(new Blob(['x']))).toThrow(/backpressure/i);
    expect(socket.sent).toHaveLength(1);
  });

  it('sanitizes malformed/provider errors and premature close', async () => {
    const { socket, onFailure, stream } = await connected();
    socket.raw('{"secret":"sensitive');
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.lastCall[0].message).not.toContain('sensitive');
    expect(() => stream.sendAudio(new ArrayBuffer(1))).toThrow(/active/i);
    const next = await connected();
    next.socket.receive({ error_type: 'service_unavailable', error_message: 'secret transcript' });
    expect(next.onFailure.mock.lastCall[0].message).not.toContain('secret transcript');
    const third = await connected();
    third.socket.close();
    expect(third.onFailure.mock.lastCall[0].message).toMatch(/closed/i);
  });

  it('bounds connect and finish waits and honors abort', async () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const stream = new SonioxStream({ onFailure: failure, WebSocketClass: FakeSocket });
    const pending = stream.connect({ apiKey: 'secret', expiresAt: Date.now() + 60000, maxSessionSeconds: 60 });
    const connectAssertion = expect(pending).rejects.toThrow(/connect timed out/i);
    await vi.advanceTimersByTimeAsync(10000);
    await connectAssertion;
    expect(failure).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const aborted = stream.connect({ apiKey: 'secret', expiresAt: Date.now() + 60000, maxSessionSeconds: 60, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow(/canceled/i);
    const { stream: active } = await connected();
    const finishing = active.finish();
    const finishAssertion = expect(finishing).rejects.toThrow(/finish timed out/i);
    await vi.advanceTimersByTimeAsync(10000);
    await finishAssertion;
  });

  it('enforces session duration and isolates callbacks after cancellation and new connect', async () => {
    vi.useFakeTimers();
    const { stream, socket, onFailure, onFinished } = await connected({ maxSessionSeconds: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sent.at(-1)).toBe('');
    expect(onFailure.mock.lastCall[0].message).toMatch(/duration/i);
    socket.receive({ tokens: [], finished: true });
    expect(onFinished).toHaveBeenCalledOnce();
    stream.cancel();
    const count = onFinished.mock.calls.length;
    const reconnect = stream.connect({ apiKey: 'fresh-secret', expiresAt: Date.now() + 60000, maxSessionSeconds: 60 });
    const fresh = FakeSocket.instances.at(-1);
    fresh.open();
    await reconnect;
    socket.receive({ tokens: [], finished: true });
    expect(onFinished).toHaveBeenCalledTimes(count);
    stream.cancel();
  });

  it('cancels pending finish without reporting a provider failure', async () => {
    const { stream, socket, onFailure, onFinished } = await connected();
    const finishing = stream.finish();
    const assertion = expect(finishing).rejects.toThrow(/canceled/i);
    stream.cancel();
    await assertion;
    expect(socket.readyState).toBe(3);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('rejects invalid token schema and transcript growth with sanitized errors', async () => {
    const malformed = await connected();
    malformed.socket.receive({ tokens: [{ text: 'private words', is_final: 'yes' }] });
    expect(malformed.onFailure.mock.lastCall[0].message).not.toContain('private words');
    const oversized = await connected();
    oversized.socket.receive({ tokens: Array.from({ length: 8193 }, () => ({ text: 'a', is_final: true })) });
    expect(oversized.onFailure.mock.lastCall[0].message).toMatch(/invalid response/i);
    expect(oversized.socket.readyState).toBe(3);
  });
});
