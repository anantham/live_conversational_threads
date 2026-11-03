// @vitest-environment node
// Test intent: tests/intent/map-structure-quality.md. Synthetic models, providers and transcripts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://fixture-evidence.example', PREFIX = '/api/cloud/openrouter';
const source = { recordingId: 'synthetic-source', startedAt: Date.UTC(2026, 10, 4), complete: true,
  finalTokens: [{ text: 'We open the show.', speaker: 'S1', startMs: 0, endMs: 2000 },
    { text: ' I grew up near the sea.', speaker: 'S2', startMs: 2500, endMs: 5000 }] };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, utterances, parent_id = null) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: id, summary: 'Synthetic.',
  source_excerpt: '', source_ref: { utterance_ids: utterances }, parent_id, secondary_parent_ids: [], thread_id: null });
// The intro chunk is filed under the childhood idea, whose own evidence is only the second turn.
const map = introParent => ({ hierarchy_format: 'tiered-parent-links-v2', edges: [], conversation_threads: [],
  metadata: { conversation_title: 'Synthetic show', executive_summary: 'An intro and a childhood story.' },
  nodes: [node(1, 'intro', ['utterance-0001'], ref(2, introParent)), node(1, 'sea', ['utterance-0002'], ref(2, 'childhood')),
    node(2, 'opening', ['utterance-0001']), node(2, 'childhood', ['utterance-0002'])] });
const reply = graph => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify(graph) } }] }), { headers: { 'content-type': 'application/json' } });
const generate = () => worker.fetch(new Request(SITE + PREFIX + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  body: JSON.stringify({ source }) }), env);
const mismatchLogs = () => warn.mock.calls.filter(([, detail]) => detail?.code === 'evidence_mismatch');

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
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return next();
    throw new Error(`Unexpected upstream URL ${url}`);
  }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('evidence-mismatch warning at the map route', () => {
  it('still saves a map with a misfiled chunk, and always logs the mismatch by tier with an example', async () => {
    next = () => reply(map('childhood'));
    const response = await generate();
    expect(response.status).toBe(200);
    expect((await response.json()).artifact.graph_data.find(n => n.id === '1:intro').parent_id).toBe('2:childhood');
    expect(mismatchLogs()).toEqual([['[openrouter] generated map files children outside their parent\'s evidence',
      { code: 'evidence_mismatch', mismatches: 1, byChildLevel: [1, 0, 0, 0],
        examples: [{ child: '1:intro', level: 1, parent: '2:childhood', missing: ['utterance-0001'] }] }]]);
  });

  it('logs nothing for a map whose children sit inside their parents\' evidence', async () => {
    next = () => reply(map('opening'));
    expect((await generate()).status).toBe(200);
    expect(mismatchLogs()).toEqual([]);
  });
});
