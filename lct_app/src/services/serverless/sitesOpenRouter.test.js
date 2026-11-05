// @vitest-environment node
// Test intent: tests/intent/sites-openrouter.md. Only synthetic input and provider fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
import { readThreadsFile } from '../threadsArtifact.js';
import { buildDiscussionModel } from '../../components/discussion/discussionModel.js';

const SITE = 'https://fixture-inference.example.chatgpt.site', PREFIX = '/api/cloud/openrouter';
const KEY = 'synthetic-owner-key';
const source = { recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 9, 3), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 1000, endMs: 2000 }] };
const graph = () => ({ metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] });
const completion = (data = graph()) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(data) } }] });
const req = (path = '/generate', { method = 'POST', headers = {}, signal, body = { source } } = {}) =>
  new Request(SITE + PREFIX + path, { method, headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1', ...headers },
    signal, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
let sqlite, env, requests;
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n;
const row = () => sqlite.prepare('SELECT * FROM lct_openrouter_attempts').get();

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); requests = [];
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true', LCT_OPENROUTER_MODEL: 'provider/selected-model',
    LCT_OPENROUTER_PROVIDER: 'selected-provider', LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048', OPENROUTER_API_KEY: KEY,
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(completion()), { status: 200 }); }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('OpenRouter Worker API with actual generated SQLite schema', () => {
  it('keeps every incomplete configuration inactive without upstream calls or reservations', async () => {
    for (const name of ['LCT_OPENROUTER_ENABLED', 'LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED', 'LCT_OPENROUTER_MODEL',
      'LCT_OPENROUTER_PROVIDER', 'LCT_OPENROUTER_DATA_COLLECTION', 'LCT_OPENROUTER_AUDIENCE', 'LCT_OPENROUTER_MAX_REQUESTS',
      'LCT_OPENROUTER_MAX_OUTPUT_TOKENS', 'OPENROUTER_API_KEY', 'DB']) {
      const previous = env[name]; delete env[name];
      expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: false });
      expect((await worker.fetch(req(), env)).status).toBe(503); env[name] = previous;
    }
    env.LCT_OPENROUTER_MAX_REQUESTS = '201';
    expect((await worker.fetch(req(), env)).status).toBe(503);
    expect(requests).toEqual([]); expect(count()).toBe(0);
  });

  it('checks actual schema readiness and refuses an absent migration before provider access', async () => {
    expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: true, available: true, schema_ready: true });
    // Isolated disposable SQLite only; proves readiness does not rely on DB.prepare presence.
    sqlite.exec('DROP TABLE lct_openrouter_attempts');
    expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: false, schema_ready: false });
    expect((await worker.fetch(req(), env)).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });

  it('requires exact processing consent/origin and authenticated identity only in configured test mode', async () => {
    for (const headers of [{ origin: '' }, { origin: 'https://fixture-evil.invalid' }, { 'x-lct-openrouter-consent': '' }]) {
      expect((await worker.fetch(req('/generate', { headers }), env)).status).toBe(403);
    }
    env.LCT_OPENROUTER_AUDIENCE = 'authenticated';
    expect((await worker.fetch(req(), env)).status).toBe(401); expect(count()).toBe(0);
    const response = await worker.fetch(req('/generate', { headers: { 'oai-authenticated-user-id': 'synthetic-account' } }), env);
    expect(response.status).toBe(200); expect(JSON.stringify(requests)).not.toContain('synthetic-account');
    expect((await worker.fetch(new Request(SITE + '/api/cloud/files'), env)).status).toBe(401);
  });

  it('uses only server policy and returns a portable source-linked map without storing content', async () => {
    fetch.mockImplementationOnce(async (url, options) => {
      if (!['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid edge redirect mode');
      requests.push({ url, options });
      return new Response(JSON.stringify(completion()), { status: 200 });
    });
    const response = await worker.fetch(req('/generate', { body: { source, model: 'untrusted/model', maxTokens: 8192, apiKey: 'untrusted-key' } }), env);
    const result = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const { url, options } = requests[0], sent = JSON.parse(options.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions'); expect(options.redirect).toBe('manual');
    expect(options.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(sent).toMatchObject({ model: 'provider/selected-model', max_tokens: 2048, stream: false,
      provider: { only: ['selected-provider'], data_collection: 'deny', require_parameters: true, allow_fallbacks: false } });
    expect(sent.response_format.json_schema.schema.properties.nodes.items.properties.source_excerpt)
      .toEqual({ type: 'string', enum: [''] });
    expect(options.body).not.toMatch(/synthetic-source|S1|startMs|untrusted\/model|untrusted-key/);
    expect(JSON.stringify(result)).not.toContain(KEY);
    const opened = await readThreadsFile(new File([JSON.stringify(result.artifact)], 'synthetic.threads'));
    expect(opened.full_transcript).toBe('An exact synthetic turn.');
    expect(buildDiscussionModel(opened.graph_data, opened.utterances).utterancesByMoment.get('moment')).toEqual(['utterance-0001']);
    expect(row()).toMatchObject({ id: result.request_id, max_output_tokens: 2048 }); expect(row().completed_at).toBeGreaterThan(0);
    expect(Object.keys(row()).sort()).toEqual(['completed_at', 'created_at', 'id', 'max_output_tokens', 'recovery_released_at']);
    expect(row().recovery_released_at).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it('refuses an upstream redirect without following or exposing its destination', async () => {
    fetch.mockResolvedValueOnce(new Response('untrusted redirect body', {
      status: 307, headers: { Location: 'https://untrusted-redirect.example.invalid/completion' },
    }));
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe('provider_refused');
    expect(JSON.stringify(body)).not.toMatch(/untrusted|synthetic-owner-key/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(count()).toBe(1);
    expect(row().completed_at).toBeNull();
  });

  it('rejects invalid, oversized and wrong-content input before admission', async () => {
    expect((await worker.fetch(req('/generate', { body: { source: { ...source, finalTokens: [] } } }), env)).status).toBe(400);
    expect((await worker.fetch(req('/generate', { body: { source, extra: 'x'.repeat(512 * 1024) } }), env)).status).toBe(413);
    expect((await worker.fetch(req('/generate', { headers: { 'content-type': 'text/plain' } }), env)).status).toBe(415);
    const invalid = new Request(SITE + PREFIX + '/generate', { method: 'POST', headers: req().headers, body: '{' });
    expect((await worker.fetch(invalid, env)).status).toBe(400);
    expect(count()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });

  it('atomically admits one simultaneous request and retains lifetime limits across policy changes', async () => {
    vi.useFakeTimers();
    const results = await Promise.all([worker.fetch(req(), env), worker.fetch(req(), env), worker.fetch(req(), env)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 429, 429]); expect(count()).toBe(1);
    expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: true, available: false });
    await vi.advanceTimersByTimeAsync(10_000); expect((await worker.fetch(req(), env)).status).toBe(200);
    env.LCT_OPENROUTER_MAX_REQUESTS = '2'; env.LCT_OPENROUTER_ENABLED = 'false';
    await worker.fetch(req(), env); env.LCT_OPENROUTER_ENABLED = 'true';
    await vi.advanceTimersByTimeAsync(10_000); expect((await worker.fetch(req(), env)).status).toBe(429);
    expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: true, available: false });
    expect(count()).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['private provider failure ' + KEY, 402], ['malformed ' + KEY, 200], ['x'.repeat(2 * 1024 * 1024 + 1), 200],
    [JSON.stringify({ ...completion(), error: { message: KEY } }), 200],
    [JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(graph()) } }] }), 200],
    [JSON.stringify(completion({ ...graph(), nodes: [{ ...graph().nodes[0], source_ref: { utterance_ids: ['invented'] } }] })), 200],
  ])('sanitizes failures and retains the attempt and uncertain slot (%#)', async (body, status) => {
    fetch.mockImplementationOnce(async () => new Response(body, { status }));
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(502); expect(await response.text()).not.toMatch(/synthetic-owner-key|private provider|malformed|invented/);
    expect(count()).toBe(1); expect(row().completed_at).toBe(null);
  });

  it('retains uncertain concurrency slots across long waits and enable toggles', async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 2; index++) {
      fetch.mockImplementationOnce(async () => new Response('unknown', { status: 200 }));
      expect((await worker.fetch(req(), env)).status).toBe(502); await vi.advanceTimersByTimeAsync(3600_000);
    }
    env.LCT_OPENROUTER_ENABLED = 'false'; await worker.fetch(req(), env); env.LCT_OPENROUTER_ENABLED = 'true';
    expect((await worker.fetch(req(), env)).status).toBe(429); expect(count()).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
    expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: true, available: false });
  });

  it('bounds stalled provider bodies and cancels the reader without refunding admission', async () => {
    vi.useFakeTimers(); let began, cancelled = false;
    const entered = new Promise(resolve => { began = resolve; });
    fetch.mockImplementationOnce(async () => { began(); return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { status: 200 }); });
    const pending = worker.fetch(req(), env); await entered; await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe(408); expect(cancelled).toBe(true); expect(count()).toBe(1); expect(row().completed_at).toBe(null);
    await vi.advanceTimersByTimeAsync(10_000); expect((await worker.fetch(req(), env)).status).toBe(200); expect(count()).toBe(2);
  });

  it('bounds stalled source bodies before admission', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const request = new Request(SITE + PREFIX + '/generate', { method: 'POST', headers: req().headers, duplex: 'half',
      body: new ReadableStream({ pull() {}, cancel() { cancelled = true; } }) });
    const pending = worker.fetch(request, env); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(408); expect(cancelled).toBe(true); expect(count()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });

  it('handles pre-admission cancellation without a call and delivered upstream cancellation conservatively', async () => {
    const before = new AbortController(); before.abort();
    expect((await worker.fetch(req('/generate', { signal: before.signal }), env)).status).toBe(408);
    expect(count()).toBe(0); expect(fetch).not.toHaveBeenCalled();
    let began, upstreamAborted = false;
    const entered = new Promise(resolve => { began = resolve; });
    fetch.mockImplementationOnce((_url, options) => { began(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
      upstreamAborted = true; reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true })); });
    const controller = new AbortController(), pending = worker.fetch(req('/generate', { signal: controller.signal }), env);
    await entered; controller.abort(); expect((await pending).status).toBe(408);
    expect(upstreamAborted).toBe(true); expect(count()).toBe(1); expect(row().completed_at).toBe(null);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
