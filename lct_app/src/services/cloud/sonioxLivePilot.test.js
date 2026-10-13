import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { runPilot, inspectSyntheticWav, classifyPilotFailure } from '../../../scripts/verify-soniox-live-pilot.mjs';

const origin = 'https://threads-adityaarpitha-cloud.avalokai.chatgpt.site';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function wav() {
  const b = Buffer.alloc(44 + 16000);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(16000, 40);
  return b;
}
const audio = wav();
const asset = Buffer.from('served synthetic client');
const options = { origin, assetPath: '/assets/index-test.js', assetSha256: hash(asset), wavPath: 'synthetic.wav',
  wavSha256: hash(audio), guardPath: 'once.guard', keywords: ['garden', 'conversation'], arm: 'SONIOX_SYNTHETIC_ONCE' };
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function setup(overrides = {}) {
  const posts = [];
  const stages = [];
  const fetcher = vi.fn(async (url, init) => {
    if (init.method === 'POST') { posts.push({ url, init }); return response({ api_key: 'snx_temp_private',
      expires_at: new Date(Date.now() + 60000).toISOString(), session_id: 'one', max_session_seconds: 300 }, 201); }
    if (url.endsWith(options.assetPath)) return response(asset.toString());
    if (url.endsWith('/soniox/status')) return response({ enabled: true, audience: 'public', max_session_seconds: 300 });
    if (url.endsWith('/openrouter/status')) return response({ enabled: false, schema_ready: true });
    throw new Error('unexpected request');
  });
  const claim = vi.fn(async () => {});
  class Stream {
    constructor(callbacks) { this.callbacks = callbacks; this.frames = []; Stream.last = this; }
    async connect(ticket) { this.ticket = ticket; }
    sendAudio(frame) { this.frames.push(frame.byteLength); this.callbacks.onTranscript({ finalText: 'garden ',
      finalTokens: [{ text: 'garden ' }], partialTokens: [] }); }
    async finish() { this.callbacks.onTranscript({ finalText: 'garden conversation',
      finalTokens: [{ text: 'garden ' }, { text: 'conversation' }], partialTokens: [] }); }
    cancel() { this.canceled = true; }
  }
  return { deps: { fetcher, read: async () => audio, claim, StreamClass: Stream,
    wait: async () => {}, emit: value => stages.push(value), ...overrides }, posts, stages, claim, Stream };
}

describe('synthetic Soniox pilot public flow', () => {
  it('emits only known reason codes for public CLI failures', () => {
    expect(classifyPilotFailure(new Error('mint_refused'))).toBe('mint_refused');
    expect(classifyPilotFailure(new Error('Live transcription provider error (organization_balance_exhausted).')))
      .toBe('provider_organization_balance_exhausted');
    expect(classifyPilotFailure(new Error('snx_temp_private arbitrary provider body'))).toBe('unknown');
    expect(classifyPilotFailure({ code: 'EEXIST', message: 'private guard path' })).toBe('attempt_already_claimed');
  });
  it('validates real RIFF PCM length and duration before admission', () => {
    expect(inspectSyntheticWav(audio).durationMs).toBe(1000);
    const broken = Buffer.from(audio); broken.writeUInt16LE(3, 20);
    expect(() => inspectSyntheticWav(broken)).toThrow('invalid_wav');
    const oversize = Buffer.alloc(2 * 1024 * 1024 + 1);
    expect(() => inspectSyntheticWav(oversize)).toThrow('invalid_wav');
  });
  it('refuses missing arm, wrong source, and provider readiness before mint', async () => {
    const s = setup();
    await expect(runPilot({ ...options, arm: '' }, s.deps)).rejects.toThrow('preflight_arguments');
    expect(s.deps.fetcher).not.toHaveBeenCalled();
    await expect(runPilot({ ...options, assetSha256: '0'.repeat(64) }, s.deps)).rejects.toThrow('source_identity');
    expect(s.claim).not.toHaveBeenCalled();
    const inactive = setup({ fetcher: vi.fn(async url => url.endsWith('/soniox/status') ?
      response({ enabled: false, audience: 'public', max_session_seconds: 300 }) : response(asset.toString())) });
    await expect(runPilot(options, inactive.deps)).rejects.toThrow('soniox_not_ready');
    expect(inactive.claim).not.toHaveBeenCalled();
    const wrongOrigin = setup();
    await expect(runPilot({ ...options, origin: 'https://other.invalid' }, wrongOrigin.deps)).rejects.toThrow('preflight_arguments');
    expect(wrongOrigin.deps.fetcher).not.toHaveBeenCalled();
    const wrongWav = setup({ read: async () => Buffer.from('RIFF') });
    await expect(runPilot(options, wrongWav.deps)).rejects.toThrow('wav_identity');
    expect(wrongWav.deps.fetcher).not.toHaveBeenCalled();
    const enabledRouter = setup({ fetcher: vi.fn(async url => url.endsWith(options.assetPath) ? response(asset.toString()) :
      url.endsWith('/soniox/status') ? response({ enabled: true, audience: 'public', max_session_seconds: 300 }) :
      response({ enabled: true, schema_ready: true })) });
    await expect(runPilot(options, enabledRouter.deps)).rejects.toThrow('openrouter_not_off');
    expect(enabledRouter.claim).not.toHaveBeenCalled();
  });
  it('claims once, sends one consent POST, streams bounded frames and returns safe evidence', async () => {
    const s = setup();
    const result = await runPilot(options, s.deps);
    expect(s.claim).toHaveBeenCalledOnce();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].url).toBe(origin + '/api/cloud/soniox/session');
    expect(s.posts[0].init.headers['X-LCT-Soniox-Consent']).toBe('transcribe-v1');
    expect(s.Stream.last.frames.reduce((a, b) => a + b, 0)).toBe(audio.length);
    expect(Math.max(...s.Stream.last.frames)).toBeLessThanOrEqual(262144);
    expect(result).toMatchObject({ outcome: 'finished', frameCount: 2, incrementalBeforeFinish: 1,
      finalTokenCount: 2, keywords: { garden: true, conversation: true } });
    expect(JSON.stringify({ result, stages: s.stages })).not.toMatch(/snx_temp|garden conversation/);
    expect(s.stages.map(x => x.stage)).toEqual(['preflight', 'authorizing', 'connecting', 'streaming', 'finalizing']);
  });
  it('keeps a consumed claim on refusal and cancels without retry', async () => {
    const s = setup({ fetcher: vi.fn(async (url, init) => init.method === 'POST' ? response({}, 429) :
      url.endsWith(options.assetPath) ? response(asset.toString()) :
      url.endsWith('/soniox/status') ? response({ enabled: true, audience: 'public', max_session_seconds: 300 }) :
      response({ enabled: false, schema_ready: true })) });
    await expect(runPilot(options, s.deps)).rejects.toThrow('mint_refused');
    expect(s.claim).toHaveBeenCalledOnce();
    expect(s.deps.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    const canceled = setup({ wait: async (_ms, signal) => { signal.dispatchEvent(new Event('abort')); throw new Error('canceled'); } });
    await expect(runPilot(options, canceled.deps)).rejects.toThrow('canceled');
    expect(canceled.Stream.last.canceled).toBe(true);
  });
  it('does not mint if the exclusive attempt guard already exists', async () => {
    const blocked = setup({ claim: vi.fn(async () => { throw new Error('EEXIST'); }) });
    await expect(runPilot(options, blocked.deps)).rejects.toThrow('EEXIST');
    expect(blocked.deps.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('does not call a connected but silent or wrong transcript a successful verification', async () => {
    const silent = setup();
    silent.deps.StreamClass = class {
      async connect() {}
      sendAudio() {}
      async finish() {}
      cancel() { this.canceled = true; }
    };
    await expect(runPilot(options, silent.deps)).rejects.toThrow('verification_failed');
    expect(silent.claim).toHaveBeenCalledOnce();
    expect(silent.posts).toHaveLength(1);
    const wrongWords = setup();
    wrongWords.deps.StreamClass = class {
      constructor(callbacks) { this.callbacks = callbacks; }
      async connect() {}
      sendAudio() { this.callbacks.onTranscript({ finalText: 'garden', finalTokens: [{ text: 'garden' }], partialTokens: [] }); }
      async finish() {}
      cancel() {}
    };
    await expect(runPilot(options, wrongWords.deps)).rejects.toThrow('verification_failed');
  });
  it('cancels a rejected adapter without a second mint', async () => {
    const failure = setup();
    failure.deps.StreamClass = class {
      async connect() { throw new Error('private provider detail'); }
      cancel() { this.canceled = true; }
    };
    await expect(runPilot(options, failure.deps)).rejects.toThrow('private provider detail');
    expect(failure.claim).toHaveBeenCalledOnce();
    expect(failure.posts).toHaveLength(1);
  });
});
