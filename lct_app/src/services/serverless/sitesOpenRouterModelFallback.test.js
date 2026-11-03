// @vitest-environment node
// Test intent: tests/intent/openrouter-model-fallback.md. Synthetic models, providers and transcripts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://fixture-fallback.example', PREFIX = '/api/cloud/openrouter';
const PRIMARY = 'vendor/primary-model', SECOND = 'vendor/second-model', THIRD = 'vendor/third-model';
const source = { recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 10, 3), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 1000, endMs: 2000 }] };
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] };
const generate = () => worker.fetch(new Request(SITE + PREFIX + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  body: JSON.stringify({ source }) }), env);
const status = async () => (await worker.fetch(new Request(SITE + PREFIX + '/status', { headers: { origin: SITE } }), env)).json();
const health = async () => (await worker.fetch(new Request(SITE + '/api/cloud/health/openrouter'), env)).json();

let sqlite, env, generations, replies;
const attempts = () => sqlite.prepare('SELECT * FROM lct_openrouter_attempts').all();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); generations = []; replies = [];
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true', LCT_OPENROUTER_MODEL: PRIMARY,
    LCT_OPENROUTER_FALLBACK_MODELS: `${SECOND},${THIRD}`,
    LCT_OPENROUTER_PROVIDER: 'approved-provider', LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048',
    // Health results are cached per key for a minute; a fresh key keeps tests independent.
    OPENROUTER_API_KEY: `synthetic-owner-key-${crypto.randomUUID()}`,
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  // Generation replies are consumed in order; anything after the queue empties succeeds.
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      generations.push(JSON.parse(options.body));
      const next = replies.shift();
      return next ? next() : json(completion);
    }
    throw new Error(`Unexpected upstream URL ${url}`);
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('approved fallback configuration', () => {
  it('reports the approved list in status so consent can name every possible model', async () => {
    expect(await status()).toMatchObject({ enabled: true, model: PRIMARY, fallback_models: [SECOND, THIRD], provider: 'approved-provider' });
  });

  it('keeps the single-model wire, call count and response when no fallback list is set', async () => {
    delete env.LCT_OPENROUTER_FALLBACK_MODELS;
    expect(await status()).toMatchObject({ enabled: true, fallback_models: [] });
    const response = await generate();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: PRIMARY });
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ model: PRIMARY, provider: { only: ['approved-provider'], data_collection: 'deny' } });
    expect(generations[0]).not.toHaveProperty('models');
  });

  it.each([
    ['an invalid model id', `${SECOND},not a model`],
    ['more than three fallbacks', 'a/one,b/two,c/three,d/four'],
    ['a duplicate', `${SECOND},${SECOND}`],
    ['the primary repeated', `${PRIMARY},${SECOND}`],
    ['an empty entry', `${SECOND},,${THIRD}`],
  ])('leaves generation unconfigured for %s, with no upstream call or reservation', async (_label, value) => {
    env.LCT_OPENROUTER_FALLBACK_MODELS = value;
    expect(await status()).toMatchObject({ enabled: false, configured: false });
    expect((await generate()).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled(); expect(attempts()).toHaveLength(0);
  });
});

describe('fallback during generation', () => {
  it.each([404, 503])('moves to the next approved model on %i with the same provider pin', async upstream => {
    replies.push(() => json({ error: { code: upstream, message: 'synthetic route refusal' } }, upstream));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await generate();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: SECOND });
    expect(generations.map(body => body.model)).toEqual([PRIMARY, SECOND]);
    // Only the model changes; provider.only and data_collection are identical.
    expect({ ...generations[1], model: undefined }).toEqual({ ...generations[0], model: undefined });
    expect(generations[1].provider).toMatchObject({ only: ['approved-provider'], data_collection: 'deny' });
    const rows = attempts(); expect(rows).toHaveLength(1); expect(rows[0].completed_at).not.toBeNull();
    expect(warn).toHaveBeenCalledWith('[openrouter] model route unavailable; trying next approved model',
      { code: 'model_fallback', upstreamStatus: upstream, from: 1, to: 2 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(env.OPENROUTER_API_KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('exact synthetic turn');
  });

  it.each([400, 401, 402, 403, 429, 502])('does not try another model on %i', async upstream => {
    replies.push(() => json({ error: { code: upstream } }, upstream));
    const response = await generate();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'provider_refused' });
    expect(generations).toHaveLength(1);
    expect(attempts()).toHaveLength(1);
  });

  it('does not try another model after a provider accepted the request but returned an unusable map', async () => {
    replies.push(() => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }] }));
    const response = await generate();
    expect(await response.json()).toMatchObject({ code: 'invalid_completion' });
    expect(generations).toHaveLength(1);
  });

  it('reports when no approved model has a route, after trying each exactly once', async () => {
    for (let i = 0; i < 3; i += 1) replies.push(() => json({ error: { code: 404 } }, 404));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await generate();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'no_model_route' });
    expect(body.error).toMatch(/No approved model/);
    expect(generations.map(request => request.model)).toEqual([PRIMARY, SECOND, THIRD]);
    expect(attempts()).toHaveLength(1);
  });
});

describe('model route preflight in the health check', () => {
  const endpointsFor = {};
  beforeEach(() => {
    for (const key of Object.keys(endpointsFor)) delete endpointsFor[key];
    fetch.mockImplementation(async (url, options) => {
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('manual');
      if (url === 'https://openrouter.ai/api/v1/key') return json({ data: { limit_remaining: 3 } });
      if (url === 'https://openrouter.ai/api/v1/credits') return json({ data: { total_credits: 5, total_usage: 1 } });
      const match = /^https:\/\/openrouter\.ai\/api\/v1\/models\/(.+)\/endpoints$/.exec(url);
      if (match && match[1] in endpointsFor) return endpointsFor[match[1]]();
      return json({ error: 'unexpected' }, 500);
    });
  });
  const tags = list => () => json({ data: { endpoints: list.map(tag => ({ tag, provider_name: 'Fixture' })) } });

  it('stays ready and says how many approved models still have a route', async () => {
    endpointsFor[PRIMARY] = tags(['other-provider']);
    endpointsFor[SECOND] = tags(['approved-provider/global', 'approved-provider/eu']);
    endpointsFor[THIRD] = tags(['approved-provider']); // bare tag, no region suffix
    const body = await health();
    expect(body).toMatchObject({ reachable: true, model_routes: { approved: 3, available: 2, unknown: 0 } });
    expect(body.detail).toContain('2 of 3 approved models');
  });

  it('needs attention when no approved model has a route on the provider', async () => {
    endpointsFor[PRIMARY] = () => json({ error: { code: 404, message: 'model not found' } }, 404); // delisted entirely
    endpointsFor[SECOND] = tags([]);
    endpointsFor[THIRD] = tags(['approved-provider-lookalike/global']);
    const body = await health();
    expect(body).toMatchObject({ reachable: false, model_routes: { approved: 3, available: 0, unknown: 0 } });
    expect(body.detail).toMatch(/No approved model/);
  });

  it('counts an unreadable listing as unknown rather than missing', async () => {
    endpointsFor[PRIMARY] = () => json({ error: 'down' }, 500);
    endpointsFor[SECOND] = () => new Response('not json', { status: 200 });
    endpointsFor[THIRD] = tags(['other-provider']);
    const body = await health();
    expect(body).toMatchObject({ reachable: true, model_routes: { approved: 3, available: 0, unknown: 2 } });
  });
});
