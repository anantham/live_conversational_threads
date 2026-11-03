// @vitest-environment node
// Test intent: tests/intent/long-input-output-budget.md. Synthetic models, providers and transcripts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
import { openRouterPolicy } from '../../../sites/openRouterPolicy.js';

const SITE = 'https://fixture-budget.example', PREFIX = '/api/cloud/openrouter';
// A transcript's length is where its last token ends; the live-session envelope is 5 minutes.
const source = (endMs, startMs = 0) => ({ recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 10, 3), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs, endMs: startMs + 1000 },
    { text: ' A later synthetic turn.', speaker: 'S2', startMs: endMs - 1000, endMs }] });
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'Two turns.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] };

let sqlite, env, generations;
const post = (body, prefix = PREFIX) => worker.fetch(new Request(SITE + prefix + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1', 'x-lct-gemini-consent': 'generate-v1' },
  body: JSON.stringify(body) }), env);
const generate = (endMs, prefix) => post({ source: source(endMs) }, prefix);
const attempts = () => sqlite.prepare('SELECT max_output_tokens FROM lct_openrouter_attempts').all().map(row => row.max_output_tokens);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); generations = [];
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true', LCT_OPENROUTER_MODEL: 'vendor/primary-model',
    LCT_OPENROUTER_PROVIDER: 'approved-provider', LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192', LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS: '16384',
    OPENROUTER_API_KEY: 'synthetic-owner-key',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === 'https://openrouter.ai/api/v1/chat/completions' || url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions') {
      generations.push(JSON.parse(options.body)); return new Response(JSON.stringify(completion)); }
    throw new Error(`Unexpected upstream URL ${url}`);
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('output budget before migration 0019', () => {
  it('refuses a long-cap admission with a clear schema error and no provider call', async () => {
    sqlite.close(); sqlite = new DatabaseSync(':memory:');
    const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    for (const entry of journal.entries.filter(e => e.tag < '0019')) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
    const response = await generate(1_200_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'schema_unavailable' });
    expect(generations).toEqual([]); expect(attempts()).toEqual([]);
    expect((await generate(300_000)).status).toBe(200);
  });
});

describe('admission storage failures other than the 0019 constraint', () => {
  it('reports a generic storage failure, not the migration message, and makes no provider call', async () => {
    const prepare = env.DB.prepare;
    env.DB = { prepare(sql) { if (sql.includes('INSERT INTO lct_openrouter_attempts')) throw new Error('SYNTHETIC database is locked'); return prepare(sql); } };
    const response = await generate(1_200_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'generation_failed' });
    expect(generations).toEqual([]); expect(attempts()).toEqual([]);
  });
});

describe('output budget by transcript length', () => {
  it('keeps the live cap for a transcript inside the 5-minute envelope, including exactly 5 minutes', async () => {
    expect((await generate(300_000)).status).toBe(200);
    expect(generations[0].max_tokens).toBe(8192);
    expect(attempts()).toEqual([8192]);
  });

  it('gives a longer transcript the long cap and records it in the attempt ledger', async () => {
    expect((await generate(1_200_000)).status).toBe(200);
    expect(generations[0].max_tokens).toBe(16384);
    expect(attempts()).toEqual([16384]);
  });

  it.each([['unset', undefined], ['empty', '']])('leaves long transcripts on the live cap when the long cap is %s', async (_label, value) => {
    env.LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS = value;
    expect((await generate(1_200_000)).status).toBe(200);
    expect(generations[0].max_tokens).toBe(8192);
    expect(attempts()).toEqual([8192]);
  });

  it('measures the validated span, so offset timestamps on a short clip keep the live cap', async () => {
    expect((await post({ source: source(301_000, 299_000) })).status).toBe(200);
    expect(generations[0].max_tokens).toBe(8192);
  });

  it('refuses an oversized token list as an invalid source before admission, never a server error', async () => {
    const response = await post({ source: { ...source(1_200_000), finalTokens: new Array(70_000).fill(0) } });
    expect(response.status).toBe(400);
    expect(attempts()).toEqual([]); expect(generations).toEqual([]);
  });

  it('applies the same caps on the Gemini route, which shares the token settings', async () => {
    Object.assign(env, { LCT_GEMINI_ENABLED: 'true', LCT_GEMINI_PROJECT_BUDGET_CONFIRMED: 'true',
      LCT_GEMINI_MODEL: 'gemini-synthetic', GEMINI_API_KEY: 'synthetic-gemini-key' });
    expect((await generate(1_200_000, '/api/cloud/gemini')).status).toBe(200);
    expect(generations[0].max_tokens).toBe(16384);
  });

  it('reports both caps in status so the consent screen can show them', async () => {
    const status = await (await worker.fetch(new Request(SITE + PREFIX + '/status'), env)).json();
    expect(status).toMatchObject({ max_output_tokens: 8192, long_max_output_tokens: 16384 });
  });

  it.each([['above 16,384', '16385'], ['below the live cap', '4096'], ['not a number', '16k']])(
    'leaves generation unconfigured for a long cap %s, never silently lower', (_label, value) => {
      env.LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS = value;
      expect(openRouterPolicy(env).configured).toBe(false);
    });
});
