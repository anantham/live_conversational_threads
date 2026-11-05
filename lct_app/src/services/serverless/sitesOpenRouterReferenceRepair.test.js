// @vitest-environment node
// Test intent: tests/intent/generation-reference-repair.md. Synthetic models, providers and transcripts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://fixture-repair.example', PREFIX = '/api/cloud/openrouter';
const source = { recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 10, 3), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 1000, endMs: 2000 }] };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, parent_id) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: id, summary: 'Synthetic.',
  source_excerpt: '', source_ref: { utterance_ids: level === 1 ? ['utterance-0001'] : [] },
  parent_id, secondary_parent_ids: [], thread_id: null });
// Declared with `node-`, referenced without it: the 3 November failure shape.
const drifted = (parent = 'turn') => ({ hierarchy_format: 'tiered-parent-links-v2',
  nodes: [node(1, 'node-moment', ref(2, parent)), node(2, 'node-turn', null)], edges: [], conversation_threads: [],
  metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' } });
const reply = graph => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] });
const generate = () => worker.fetch(new Request(SITE + PREFIX + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  body: JSON.stringify({ source }) }), env);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let sqlite, env, next, warn;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true', LCT_OPENROUTER_MODEL: 'vendor/primary-model',
    LCT_OPENROUTER_PROVIDER: 'approved-provider', LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048', OPENROUTER_API_KEY: 'synthetic-owner-key',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  // Repairs are logged whatever LCT_OPENROUTER_DEBUG says, like a model fallback.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return next();
    throw new Error(`Unexpected upstream URL ${url}`);
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('reference repair at the map route', () => {
  it('saves a repaired map, reports the repair in the response and always logs it', async () => {
    next = () => reply(drifted());
    const response = await generate();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reference_repair).toEqual({ operation: 'add_prefix', affix: 'node-', references: 1 });
    expect(body.artifact.graph_data.find(n => n.id === '1:node-moment').parent_id).toBe('2:node-turn');
    expect(warn).toHaveBeenCalledWith('[openrouter] repaired generated references',
      { code: 'reference_repair', operation: 'add_prefix', affix: 'node-', references: 1 });
  });

  it('adds nothing to a clean reply', async () => {
    next = () => reply(drifted('node-turn'));
    const body = await (await generate()).json();
    expect(body).not.toHaveProperty('reference_repair');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still refuses a reply the repair cannot resolve, keeping the attempt counted', async () => {
    next = () => reply(drifted('theme'));
    const response = await generate();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'invalid_completion' });
    expect(warn).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT completed_at FROM lct_openrouter_attempts').all()).toEqual([{ completed_at: null }]);
  });
});
