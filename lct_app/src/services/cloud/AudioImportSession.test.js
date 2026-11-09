// Test Intent: tests/intent/cloud-audio-import.md. One public session, observable audio/tokens and refusal.
import { describe, expect, it, vi } from 'vitest';
import { AudioImportSession } from './AudioImportSession.js';
const words = { finalText: 'Gardens need water.', partialText: '', partialTokens: [],
  finalTokens: [{ text: 'Gardens need water.', speaker: '1', startMs: 0, endMs: 100 }] };
const key = { api_key: 'synthetic-temporary-key', session_id: 'synthetic-session', expires_at: new Date(Date.now() + 60000).toISOString(), max_session_seconds: 300 };
function setup() {
  const evidence = { frames: [], configurations: [] };
  class Stream {
    constructor(callbacks) { this.callbacks = callbacks; }
    async connect(config) { evidence.configurations.push(config); }
    sendAudio(bytes) { evidence.frames.push(new Uint8Array(bytes)); this.callbacks.onTranscript(words); }
    async finish() {}
    cancel() { evidence.closed = true; }
  }
  const decode = vi.fn(async () => ({ pcm: new ArrayBuffer(6400), mimeType: 'audio/mpeg', durationMs: 200 }));
  const requestSession = vi.fn(async () => key), audio = [], transcripts = [], stages = [];
  const session = new AudioImportSession({ StreamClass: Stream, decode, requestSession,
    onAudio: value => audio.push(value), onTranscript: value => transcripts.push(value), onStage: value => stages.push(value.stage) });
  return { session, evidence, decode, requestSession, audio, transcripts, stages, file: new File(['original synthetic audio'], 'garden.mp3') };
}
describe('audio import session', () => {
  it('preserves original audio and uses one PCM session with finalized speaker/timing tokens', async () => {
    const s = setup(), result = await s.session.start({ file: s.file, maxSessionSeconds: 300 });
    expect(s.requestSession).toHaveBeenCalledTimes(1);
    expect(s.evidence.configurations[0]).toMatchObject({ audioFormat: 'pcm_s16le', sampleRate: 16000, numChannels: 1, maxSessionSeconds: 300 });
    expect(s.audio[0].blob.size).toBe(s.file.size); expect(s.audio[0].complete).toBe(true);
    expect(s.evidence.frames).toHaveLength(1); expect(s.evidence.frames[0].length).toBe(6400);
    expect(result.finalTokens).toEqual(words.finalTokens); expect(s.stages.at(-1)).toBe('stopped');
    expect(s.evidence.closed).toBe(true);
  });
  it('refuses decode errors before minting and retains original audio after provider refusal', async () => {
    const invalid = setup(); invalid.decode.mockRejectedValue(new Error('Unsupported codec'));
    await expect(invalid.session.start({ file: invalid.file, maxSessionSeconds: 300 })).rejects.toThrow('Unsupported codec');
    expect(invalid.requestSession).not.toHaveBeenCalled(); expect(invalid.audio).toHaveLength(0);
    const refused = setup(); refused.requestSession.mockRejectedValue(new Error('Provider refused'));
    await expect(refused.session.start({ file: refused.file, maxSessionSeconds: 300 })).rejects.toThrow('Provider refused');
    expect(refused.audio[0].blob.size).toBe(refused.file.size);
    expect(refused.evidence.frames).toHaveLength(0); expect(refused.requestSession).toHaveBeenCalledTimes(1);
  });
  it('cancels late decoding without minting, emitting audio or starting a replacement session', async () => {
    const s = setup(); let finish;
    s.decode.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = s.session.start({ file: s.file, maxSessionSeconds: 300 }); s.session.cancel();
    await expect(s.session.start({ file: s.file, maxSessionSeconds: 300 })).rejects.toThrow('already active');
    finish({ pcm: new ArrayBuffer(6400), mimeType: 'audio/mpeg', durationMs: 200 });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.requestSession).not.toHaveBeenCalled(); expect(s.audio).toHaveLength(0);
    expect(s.stages.at(-1)).toBe('cancelled');
  });
  it('does not stream a file beyond the actual issued key duration', async () => {
    const s = setup(); s.decode.mockResolvedValue({ pcm: new ArrayBuffer(16000 * 2 * 20), mimeType: 'audio/mpeg', durationMs: 20000 });
    s.requestSession.mockResolvedValue({ ...key, max_session_seconds: 15 });
    await expect(s.session.start({ file: s.file, maxSessionSeconds: 300 })).rejects.toThrow('current provider session limit');
    expect(s.evidence.frames).toHaveLength(0); expect(s.audio).toHaveLength(1);
  });
});
