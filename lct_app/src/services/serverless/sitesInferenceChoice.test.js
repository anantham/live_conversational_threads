// @vitest-environment node
// Test intent: tests/intent/sites-inference-choice.md. Only synthetic input and provider fixtures.
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


describe('Selected inference backend through the Worker boundary', () => {
  const gemini = (headers = {}, signal) => new Request(SITE + '/api/cloud/gemini/generate', {
    method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-gemini-consent': 'generate-v1', ...headers },
    signal, body: JSON.stringify({ source, model: 'untrusted/model', apiKey: 'untrusted-key', endpoint: 'https://evil.invalid' }),
  });
  beforeEach(() => Object.assign(env, { GEMINI_API_KEY: 'synthetic-gemini-key', LCT_GEMINI_MODEL: 'gemini-3.5-flash-lite',
    LCT_GEMINI_ENABLED: 'true', LCT_GEMINI_PROJECT_BUDGET_CONFIRMED: 'true', OPENROUTER_API_KEY_2: 'synthetic-replacement-key' }));
  it('uses only direct Gemini configuration and returns a source-linked portable map', async () => {
    const response = await worker.fetch(gemini(), env), payload = await response.json();
    expect(response.status).toBe(200); expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(requests[0].options.headers.Authorization).toBe('Bearer synthetic-gemini-key');
    const body = JSON.parse(requests[0].options.body);
    expect(body.model).toBe('gemini-3.5-flash-lite'); expect(body.max_tokens).toBe(2048);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'stream']);
    expect(body.provider).toBeUndefined(); expect(body.response_format.type).toBe('json_schema');
    expect(JSON.stringify(payload)).not.toMatch(/synthetic-gemini-key|synthetic-replacement-key|untrusted-key/);
    const opened = await readThreadsFile(new File([JSON.stringify(payload.artifact)], 'synthetic.threads'));
    expect(opened.full_transcript).toBe(source.finalTokens[0].text);
    expect(buildDiscussionModel(opened.graph_data, opened.utterances).utterancesByMoment.get('moment')).toEqual(['utterance-0001']);
    expect(count()).toBe(1); expect(row().completed_at).toBeGreaterThan(0);
  });
  it('uses the replacement OpenRouter key and never exposes it in readiness', async () => {
    expect((await worker.fetch(req(), env)).status).toBe(200);
    expect(requests[0].options.headers.Authorization).toBe('Bearer synthetic-replacement-key');
    const status = await (await worker.fetch(req('/status', { method: 'GET' }), env)).text();
    expect(status).not.toMatch(/synthetic-replacement-key|synthetic-owner-key/);
  });
  it('requires direct consent and complete configuration independently of the OpenRouter key', async () => {
    expect((await worker.fetch(gemini({ 'x-lct-gemini-consent': '', 'x-lct-openrouter-consent': 'generate-v1' }), env)).status).toBe(403);
    for (const name of ['GEMINI_API_KEY', 'LCT_GEMINI_MODEL', 'LCT_GEMINI_ENABLED', 'LCT_GEMINI_PROJECT_BUDGET_CONFIRMED']) {
      const prior = env[name]; delete env[name]; expect((await worker.fetch(gemini(), env)).status).toBe(503); env[name] = prior;
    }
    expect((await worker.fetch(req('/generate', { headers: { 'x-lct-openrouter-consent': '', 'x-lct-gemini-consent': 'generate-v1' } }), env)).status).toBe(403);
    expect(count()).toBe(0); expect(requests).toHaveLength(0);
    delete env.OPENROUTER_API_KEY; delete env.OPENROUTER_API_KEY_2;
    delete env.LCT_OPENROUTER_MODEL; delete env.LCT_OPENROUTER_PROVIDER; delete env.LCT_OPENROUTER_ENABLED;
    expect((await worker.fetch(gemini(), env)).status).toBe(200);
  });
  it('shares interval and lifetime admission across routes without resetting quota', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.now());
    env.LCT_OPENROUTER_MAX_REQUESTS = '1';
    expect((await worker.fetch(gemini(), env)).status).toBe(200);
    vi.setSystemTime(Date.now() + 10001);
    expect((await worker.fetch(req(), env)).status).toBe(429);
    expect(count()).toBe(1); expect(requests).toHaveLength(1);
    expect((await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).available).toBe(false);
  });
  it('reports Gemini readiness without secrets and shares unresolved holders in both directions', async () => {
    const status = await (await worker.fetch(new Request(SITE + '/api/cloud/gemini/status'), env)).json();
    expect(status).toMatchObject({ backend: 'gemini', provider: 'Google AI Studio', enabled: true, available: true });
    expect(JSON.stringify(status)).not.toMatch(/synthetic-gemini-key|synthetic-replacement-key/);
    vi.useFakeTimers(); vi.setSystemTime(Date.now());
    fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    expect((await worker.fetch(gemini(), env)).status).toBe(502);
    vi.setSystemTime(Date.now() + 10001);
    expect((await worker.fetch(req(), env)).status).toBe(502);
    vi.setSystemTime(Date.now() + 10001);
    expect((await worker.fetch(gemini(), env)).status).toBe(429);
    expect((await worker.fetch(req(), env)).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(2); expect(count()).toBe(2);
  });
  it.each([401, 429, 500, 302])('retains failed attempts on upstream %s with no retry or fallback', async status => {
    fetch.mockImplementation(async (url, options) => { requests.push({ url, options }); return new Response('{}', { status }); });
    expect((await worker.fetch(gemini(), env)).status).toBe(502);
    expect(requests).toHaveLength(1); expect(requests[0].url).toContain('googleapis.com');
    expect(count()).toBe(1); expect(row().completed_at).toBeNull(); expect(row().recovery_released_at).toBeNull();
  });
  it('refuses incomplete output and unknown backend without trying another service', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] })));
    expect((await worker.fetch(gemini(), env)).status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(new Request(SITE + '/api/cloud/unknown/generate'), env)).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1); expect(row().completed_at).toBeNull();
  });
  it('refuses pre-cancellation and preserves delivered cancellation accounting', async () => {
    const before = new AbortController(); before.abort();
    expect((await worker.fetch(gemini({}, before.signal), env)).status).toBe(408); expect(count()).toBe(0);
    const during = new AbortController();
    fetch.mockImplementation(async () => { during.abort(); return new Response(JSON.stringify(completion())); });
    expect((await worker.fetch(gemini({}, during.signal), env)).status).toBe(408);
    expect(fetch).toHaveBeenCalledTimes(1); expect(count()).toBe(1); expect(row().completed_at).toBeNull();
  });
});
