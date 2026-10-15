// @vitest-environment node
// Intent: tests/intent/openrouter-live-pilot-oct14.md. Intercepted fetch only; no network or artifact persistence.
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import { runPilot, classifyPilotFailure, SYNTHETIC_SOURCE } from '../../../scripts/verify-openrouter-live-pilot.mjs';
import { getRecordingMapStatus, generateRecordingMap } from './openRouterClient.js';
import { createRecordingThreads } from './recordingThreads.js';
import { readThreadsFile } from '../threadsArtifact.js';
import { buildDiscussionModel } from '../../components/discussion/discussionModel.js';

const origin = 'https://threads-adityaarpitha-cloud.avalokai.chatgpt.site';
const adapter = new URL('./openRouterClient.js', import.meta.url);
const consumers = { getRecordingMapStatus, generateRecordingMap, readThreadsFile, buildDiscussionModel };
const status = { backend: 'openrouter', enabled: true, available: true, configured: true, schema_ready: true, audience: 'public',
  model: 'google/gemini-2.5-flash-lite', provider: 'google-vertex', max_output_tokens: 8192 };
const graph = { nodes: [
  { id: 'moment-a', node_name: 'First sentence', semantic_level: 1, semantic_type: 'chunk',
    source_ref: { utterance_ids: ['utterance-0001'] } },
  { id: 'moment-b', node_name: 'Second sentence', semantic_level: 1, semantic_type: 'chunk',
    source_ref: { utterance_ids: ['utterance-0002'] } },
], edges: [], conversation_threads: [{ id: 'synthetic-path', title: 'Two linked turns', steps: [
  { moment_id: 'moment-a', evidence_utterance_ids: ['utterance-0001'] },
  { moment_id: 'moment-b', evidence_utterance_ids: ['utterance-0002'] },
] }] };
const json = (value, code = 200) => new Response(JSON.stringify(value), { status: code,
  headers: { 'content-type': 'application/json' } });
async function fixture(overrides = {}) {
  const adapterBytes = await readFile(adapter);
  const adapterSha256 = createHash('sha256').update(adapterBytes).digest('hex');
  const options = { origin, adapterSha256, guardPath: 'synthetic.once.guard', arm: 'OPENROUTER_SYNTHETIC_ONCE' };
  let claimed = false;
  const claim = vi.fn(async () => { if (claimed) { const error = new Error('private path'); error.code = 'EEXIST'; throw error; } claimed = true; });
  const fetcher = vi.fn(async (url) => {
    if (url === `${origin}/api/cloud/openrouter/status`) return json(overrides.status ?? status);
    if (url === `${origin}/api/cloud/openrouter/generate`) return overrides.generate ?? json({
      request_id: '00000000-0000-4000-8000-000000000001',
      artifact: createRecordingThreads({ ...SYNTHETIC_SOURCE, graph }).bundle,
    });
    throw new Error('unexpected endpoint');
  });
  const stages = [];
  const deps = { consumers, fetcher, claim, read: async () => adapterBytes,
    emit: value => stages.push(value), ...overrides.deps };
  const posts = () => fetcher.mock.calls.filter(([, init]) => init.method === 'POST');
  return { options, deps, fetcher, claim, posts, stages };
}

describe('one-attempt synthetic OpenRouter pilot', () => {
  it('uses actual browser adapter, portable reader and Discussion links with one consented POST', async () => {
    const f = await fixture();
    delete f.deps.consumers; // Exercise the CLI's in-memory Node bundle of the unchanged browser modules.
    const result = await runPilot(f.options, f.deps);
    expect(result).toMatchObject({ outcome: 'verified', postCount: 1, utteranceCount: 2,
      momentCount: 2, linkedMomentCount: 2, threadCount: 1 });
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0][1].headers).toMatchObject({ Origin: origin,
      'X-LCT-OpenRouter-Consent': 'generate-v1' });
    expect(f.posts()[0][1].redirect).toBe('error');
    expect(JSON.parse(f.posts()[0][1].body)).toEqual({ source: SYNTHETIC_SOURCE });
    expect(f.stages.filter((value, index, all) => index === 0 || value.stage !== all[index - 1].stage)
      .map(value => value.stage)).toEqual(['preflight', 'generating', 'verifying']);
    expect(f.stages.every(value => Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0)).toBe(true);
    expect(f.stages.map(value => value.elapsedMs)).toEqual(f.stages.map(value => value.elapsedMs).sort((a, b) => a - b));
    expect(f.stages.every(value => value.remaining === 'Time remaining unknown')).toBe(true);
    expect(JSON.stringify({ result, stages: f.stages })).not.toContain(SYNTHETIC_SOURCE.finalTokens[0].text);
  });
  it('updates elapsed preflight during slow loading and stops status updates after completion', async () => {
    const f = await fixture();
    let ready;
    f.deps.consumers = new Promise(resolveReady => { ready = resolveReady; });
    vi.useFakeTimers();
    try {
      const pending = runPilot(f.options, f.deps);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.stages).toHaveLength(3);
      expect(f.stages.every(value => value.stage === 'preflight' && value.remaining === 'Time remaining unknown')).toBe(true);
      expect(f.stages.map(value => value.elapsedMs)).toEqual([0, 1000, 2000]);
      expect(f.posts()).toHaveLength(0);
      ready(consumers);
      expect((await pending).outcome).toBe('verified');
      const completedUpdates = f.stages.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.stages).toHaveLength(completedUpdates);
      expect(f.posts()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('refuses source hash, arm, origin, and all readiness drift before a claim or POST', async () => {
    for (const change of [{ arm: '' }, { origin: 'https://wrong.invalid' }, { adapterSha256: '0'.repeat(64) }]) {
      const f = await fixture();
      await expect(runPilot({ ...f.options, ...change }, f.deps)).rejects.toThrow();
      expect(f.claim).not.toHaveBeenCalled(); expect(f.posts()).toHaveLength(0);
    }
    for (const drift of [{ enabled: false }, { available: false }, { configured: false },
      { schema_ready: false }, { audience: 'authenticated' }, { model: 'other/model' },
      { provider: 'other-provider' }, { max_output_tokens: 4096 }]) {
      const f = await fixture({ status: { ...status, ...drift } });
      await expect(runPilot(f.options, f.deps)).rejects.toThrow('status_not_ready');
      expect(f.claim).not.toHaveBeenCalled(); expect(f.posts()).toHaveLength(0);
    }
  });
  it('accepts a usable source-linked map with no optional conversation paths', async () => {
    const f = await fixture({ generate: json({ request_id: '00000000-0000-4000-8000-000000000001',
      artifact: createRecordingThreads({ ...SYNTHETIC_SOURCE,
        graph: { ...graph, conversation_threads: [] } }).bundle }) });
    expect(await runPilot(f.options, f.deps)).toMatchObject({ outcome: 'verified',
      postCount: 1, momentCount: 2, linkedMomentCount: 2, threadCount: 0 });
    expect(f.posts()).toHaveLength(1);
  });
  it('retains the real exclusive filesystem guard and refuses reuse before another POST', async () => {
    const parent = resolve(tmpdir());
    const pilotDir = await mkdtemp(join(parent, 'lct-or-once-'));
    if (dirname(resolve(pilotDir)) !== parent || !basename(pilotDir).startsWith('lct-or-once-')) {
      throw new Error('Unexpected test cleanup target');
    }
    try {
      const f = await fixture();
      f.options.guardPath = join(pilotDir, 'once.guard');
      delete f.deps.claim;
      expect((await runPilot(f.options, f.deps)).outcome).toBe('verified');
      expect((await stat(f.options.guardPath)).isFile()).toBe(true);
      await expect(runPilot(f.options, f.deps)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(f.posts()).toHaveLength(1);
    } finally {
      await rm(pilotDir, { recursive: true, force: true });
    }
  });
  it('retains an exclusive guard and makes no second POST after refusal or invalid artifact', async () => {
    for (const generate of [json({ code: 'private-error', error: 'private body' }, 429),
      json({ request_id: '00000000-0000-4000-8000-000000000001', artifact: {} })]) {
      const f = await fixture({ generate });
      await expect(runPilot(f.options, f.deps)).rejects.toThrow('request_refused');
      expect(f.posts()).toHaveLength(1);
      expect(f.claim).toHaveBeenCalledOnce();
      await expect(runPilot(f.options, f.deps)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(f.posts()).toHaveLength(1);
    }
  });
  it('rejects a readable but empty generated graph as unusable', async () => {
    const f = await fixture({ generate: json({ request_id: '00000000-0000-4000-8000-000000000001',
      artifact: createRecordingThreads({ ...SYNTHETIC_SOURCE,
        graph: { nodes: [{ id: 'idea', node_name: 'No moment', semantic_level: 2, semantic_type: 'idea',
          source_ref: { utterance_ids: [] } }], edges: [] } }).bundle }) });
    await expect(runPilot(f.options, f.deps)).rejects.toThrow('artifact_unusable');
    expect(f.posts()).toHaveLength(1);
  });
  it('cancels and times out a stalled POST while keeping its guard and one POST', async () => {
    for (const mode of ['cancel', 'timeout']) {
      const f = await fixture();
      const controller = new AbortController();
      f.deps.signal = controller.signal;
      let started;
      const postStarted = new Promise(resolveStart => { started = resolveStart; });
      let startTimer;
      const startDeadline = new Promise((_, reject) => {
        startTimer = realSetTimeout(() => reject(new Error('POST did not start')), 2000);
      });
      f.deps.fetcher = vi.fn((url, init) => url.endsWith('/status') ? Promise.resolve(json(status)) :
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('private body')), { once: true });
          started();
        }));
      try {
        if (mode === 'timeout') { vi.useFakeTimers(); f.deps.deadlineMs = 20; }
        const pending = runPilot(f.options, f.deps);
        const assertion = expect(pending).rejects.toThrow(mode === 'cancel' ? 'canceled' : 'overall_timeout');
        await Promise.race([postStarted, startDeadline]);
        if (mode === 'cancel') controller.abort();
        else await vi.advanceTimersByTimeAsync(20);
        await assertion;
      } finally {
        realClearTimeout(startTimer);
        controller.abort();
        vi.useRealTimers();
      }
      expect(f.claim).toHaveBeenCalledOnce();
      expect(f.deps.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      f.deps.signal = undefined;
      f.deps.deadlineMs = undefined;
      await expect(runPilot(f.options, f.deps)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(f.deps.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    }
  });
  it('maps arbitrary private failures to a fixed public code', () => {
    expect(classifyPilotFailure(new Error('private body 00000000-0000-4000-8000-000000000001'))).toBe('unknown');
    expect(classifyPilotFailure({ code: 'EEXIST', message: 'private guard path' })).toBe('attempt_already_claimed');
  });
});
