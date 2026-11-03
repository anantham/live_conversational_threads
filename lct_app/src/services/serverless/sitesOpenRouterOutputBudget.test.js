// @vitest-environment node
// Test intent: tests/intent/long-input-output-budget.md. Synthetic models, providers and transcripts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
import { openRouterPolicy } from '../../../sites/openRouterPolicy.js';

const SITE = 'https://fixture-budget.example', PREFIX = '/api/cloud/openrouter';
// A transcript's length is where its last token ends; the live-session envelope is 5 minutes.
const source = endMs => ({ recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 10, 3), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 1000, endMs: 2000 },
    { text: ' A later synthetic turn.', speaker: 'S2', startMs: endMs - 1000, endMs }] });
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'Two turns.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] };

let sqlite, env, generations;
const generate = (endMs, prefix = PREFIX) => worker.fetch(new Request(SITE + prefix + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1', 'x-lct-gemini-consent': 'generate-v1' },
  body: JSON.stringify({ source: source(endMs) }) }), env);
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
    if (url === 'https://openrouter.ai/api/v1/chat/completions') { generations.push(JSON.parse(options.body)); return new Response(JSON.stringify(completion)); }
    throw new Error(`Unexpected upstream URL ${url}`);
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
