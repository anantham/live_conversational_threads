// Test Intent: sites-live-workspace.md. All audio, tokens and provider keys are synthetic.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudConversationSession } from './cloudConversationSession.js';
import { RecordingSession } from './recordingSession.js';

function setup() {
  const recorders = [], connections = [], tracks = [];
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor() { super(); this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.dispatchEvent(new MessageEvent('dataavailable', { data: new Blob(['synthetic segment']) })); this.dispatchEvent(new Event('stop')); }
  }
  class Stream {
    constructor(callbacks) { this.callbacks = callbacks; this.finish = vi.fn(async () => {}); this.cancel = vi.fn(); connections.push(this); }
    async connect() {}
    sendAudio() {}
  }
  const requestSession = vi.fn(async () => ({ api_key: 'synthetic', expires_at: new Date(Date.now() + 60000).toISOString(), session_id: 'synthetic-session', max_session_seconds: 60 }));
  class Session extends RecordingSession {
    constructor(callbacks) { super({ ...callbacks, StreamClass: Stream, MediaRecorderClass: Recorder, requestSession, mediaDevices: { getUserMedia: async () => { const track = { stop: vi.fn() }; tracks.push(track); return { getTracks: () => [track] }; } } }); }
  }
  const onStage = vi.fn(), onAudio = vi.fn(), onTranscript = vi.fn(), onFailure = vi.fn();
  const session = new CloudConversationSession({ SessionClass: Session, onStage, onAudio, onTranscript, onFailure });
  return { session, recorders, connections, tracks, onStage, onAudio, onTranscript, onFailure, requestSession };
}
const snapshot = text => ({ finalTokens: [{ text, speaker: '1', startMs: 100, endMs: 500 }], partialTokens: [], finalText: text, partialText: '' });
afterEach(() => vi.useRealTimers());
describe('cloud conversation continuity', () => {
  it('pauses the real recorder/stream, resumes with fresh authorization, preserves exact segments and ignores stale callbacks', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.session.start({ transcribe: true, maxSessionSeconds: 60 });
    f.connections[0].callbacks.onTranscript(snapshot('First thought.'));
    await vi.advanceTimersByTimeAsync(5000);
    await f.session.pause();
    expect(f.tracks[0].stop).toHaveBeenCalled();
    expect(f.connections[0].finish).toHaveBeenCalledOnce();
    expect(f.session.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.requestSession).toHaveBeenCalledOnce();
    await f.session.resume();
    expect(f.requestSession).toHaveBeenCalledTimes(2);
    f.connections[0].callbacks.onTranscript(snapshot('Late old words.'));
    f.connections[1].callbacks.onTranscript(snapshot('A new tangent.'));
    expect(f.onTranscript.mock.lastCall[0].finalText).toBe('First thought.\nA new tangent.');
    expect(f.onTranscript.mock.lastCall[0].finalTokens.at(-1)).toMatchObject({ speaker: 'segment-2:1', startMs: 5100 });
    await f.session.stop();
    expect(f.onAudio.mock.lastCall[0].segments).toHaveLength(2);
    expect(f.onAudio.mock.lastCall[0].segments.every(s => s.blob.size === 17)).toBe(true);
    expect(f.session.state).toBe('stopped');
    expect(f.tracks.every(t => t.stop.mock.calls.length > 0)).toBe(true);
  });
  it('finishes from pause without starting a new connection and cannot resume a cancelled conversation', async () => {
    const f = setup(); await f.session.start({ transcribe: false, maxSessionSeconds: 60 });
    await f.session.pause(); await f.session.stop();
    expect(f.session.state).toBe('stopped'); expect(f.recorders).toHaveLength(1);
    await f.session.resume(); expect(f.recorders).toHaveLength(1);
    expect(f.requestSession).not.toHaveBeenCalled();
    f.session.cancel();
  });
  it('does not reset the total active duration allowance after pausing', async () => {
    vi.useFakeTimers(); const f = setup(); await f.session.start({ transcribe: true, maxSessionSeconds: 30 });
    await vi.advanceTimersByTimeAsync(16000); await f.session.pause(); await f.session.resume();
    expect(f.session.state).toBe('stopped'); expect(f.requestSession).toHaveBeenCalledOnce();
    expect(f.onAudio.mock.lastCall[0].segments).toHaveLength(1);
  });
  it('preserves prior source/audio when resumed authorization fails', async () => {
    const f = setup(); await f.session.start({ transcribe: true, maxSessionSeconds: 60 });
    f.connections[0].callbacks.onTranscript(snapshot('Retain this.')); await f.session.pause();
    f.requestSession.mockRejectedValueOnce(new Error('provider failure'));
    await expect(f.session.resume()).rejects.toThrow();
    expect(f.session.transcript.finalText).toBe('Retain this.');
    expect(f.onAudio.mock.lastCall[0].segments).toHaveLength(1);
    expect(f.session.state).toBe('error'); expect(f.tracks[1].stop).toHaveBeenCalled();
  });
  it('refuses Resume during finalization and retains the provider flush before opening the next segment', async () => {
    const f = setup(); await f.session.start({ transcribe: true, maxSessionSeconds: 60 });
    f.connections[0].callbacks.onTranscript(snapshot('First draft.'));
    let finish; f.connections[0].finish.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pausing = f.session.pause();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(f.session.state).toBe('finalizing');
    await f.session.resume(); expect(f.requestSession).toHaveBeenCalledOnce();
    f.connections[0].callbacks.onTranscript(snapshot('Final flushed words.')); finish(); await pausing;
    expect(f.session.state).toBe('paused');
    await f.session.resume(); f.connections[1].callbacks.onTranscript(snapshot('Next segment.'));
    expect(f.onTranscript.mock.lastCall[0].finalText).toBe('Final flushed words.\nNext segment.');
    await f.session.stop();
  });

});
