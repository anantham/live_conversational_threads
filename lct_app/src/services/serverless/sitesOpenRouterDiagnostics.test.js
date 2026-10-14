// @vitest-environment node
// Test intent: tests/intent/sites-openrouter.md. Synthetic data; no live provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { logOpenRouterFailure } from '../../../sites/openRouter.js';

const SITE = 'https://fixture-diagnostics.example.chatgpt.site';
const KEY = 'synthetic-diagnostic-secret';
const source = { recordingId: 'synthetic-private-recording', startedAt: Date.UTC(2026, 9, 9), complete: true,
  finalTokens: [{ text: 'A private synthetic utterance.', speaker: 'synthetic-speaker', startMs: 0, endMs: 1000 }] };
const graph = () => ({ metadata: { conversation_title: 'Synthetic private title', executive_summary: 'Synthetic summary' },
  nodes: [{ id: 'synthetic-node', semantic_level: 1, semantic_type: 'chunk', node_name: 'Synthetic private node',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', children_ids: [] }], edges: [], conversation_threads: [] });
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph()) } }] });
const request = () => new Request(SITE + '/api/cloud/openrouter/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' }, body: JSON.stringify({ source }) });
let sqlite, env, worker, logged;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  expect(sqlite.prepare('PRAGMA table_info(lct_openrouter_attempts)').all().map(column => column.name))
    .toEqual(['id', 'created_at', 'max_output_tokens', 'completed_at', 'recovery_released_at']);
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_OPENROUTER_MODEL: 'provider/synthetic-model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
    LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public', LCT_OPENROUTER_DEBUG: 'true',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048', OPENROUTER_API_KEY: KEY,
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion()), { status: 200 })));
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Migrations, lease root and intercepted provider exist before importing Worker.
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function rejectedGraph(mutate) {
  const value = graph(); mutate(value);
  const response = completion(); response.choices[0].message.content = JSON.stringify(value);
  return response;
}

function hierarchyGraph() {
  const value = graph();
  const makeNode = (id, semantic_level, parent_id, children_ids) => ({
    id, semantic_level, semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][semantic_level - 1],
    node_name: `Synthetic ${id}`, summary: '', source_excerpt: '', source_ref: { utterance_ids: semantic_level === 1 ? ['utterance-0001'] : [] },
    parent_id, children_ids, thread_id: null, memberships: [],
  });
  value.nodes = [makeNode('synthetic-node', 1, 'idea', []), makeNode('idea', 2, 'topic', ['synthetic-node']),
    makeNode('topic', 3, 'theme', ['idea']), makeNode('theme', 4, 'arc', ['topic']), makeNode('arc', 5, null, ['theme'])];
  return value;
}

function hierarchyCompletion(mutate) {
  const value = hierarchyGraph(); mutate(value);
  const response = completion(); response.choices[0].message.content = JSON.stringify(value);
  return response;
}

describe('redacted OpenRouter validation diagnostics through the public Worker', () => {
  it.each([
    ['response_envelope', () => ({ choices: [], error: { message: KEY } })],
    ['choice_tools_empty', () => { const value = completion(); value.choices[0].message.tool_calls = []; return value; }],
    ['choice_finish', () => { const value = completion(); value.choices[0].finish_reason = 'untrusted-finish-' + KEY; return value; }],
    ['content_json', () => { const value = completion(); value.choices[0].message.content = '{' + KEY; return value; }],
    ['required_shape', () => { const value = completion(); value.choices[0].message.content = '{}'; return value; }],
    ['graph_shape', () => rejectedGraph(value => { value.nodes = []; })],
    ['node_evidence', () => rejectedGraph(value => { value.nodes[0].source_ref.utterance_ids = ['invented-' + KEY]; })],
    ['node_excerpt', () => rejectedGraph(value => { value.nodes[0].source_excerpt = 'invented-' + KEY; })],
    ['hierarchy', () => rejectedGraph(value => { value.nodes[0].parent_id = 'invented-' + KEY; })],
    ['edges', () => rejectedGraph(value => { value.edges = [{ id: 'private-edge', from_node_id: 'synthetic-node',
      to_node_id: 'invented-' + KEY, relation_type: 'relates_to' }]; })],
    ['threads', () => rejectedGraph(value => { value.conversation_threads = [{ id: 'private-path', title: KEY,
      steps: [{ moment_id: 'invented-' + KEY, evidence_utterance_ids: ['utterance-0001'] }] }]; })],
  ])('identifies %s without retaining or exposing completion content', async (stage, makeResponse) => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(makeResponse()), { status: 200 }));
    const response = await worker.fetch(request(), env), body = await response.json();
    expect(response.status).toBe(502); expect(body.code).toBe('invalid_completion'); expect(body.artifact).toBeUndefined();
    expect(logged.mock.calls).toEqual([['[openrouter] generation failed', { code: 'invalid_completion',
      validationStage: stage, ...(stage === 'hierarchy' ? { validationRule: 'parent_missing' } : {}) }]]);
    expect(JSON.stringify({ body, logs: logged.mock.calls })).not.toMatch(/synthetic-|utterance-0001|invented-|private-path|private-edge/);
    const rows = sqlite.prepare('SELECT * FROM lct_openrouter_attempts').all();
    expect(rows).toHaveLength(1); expect(rows[0].completed_at).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it.each([
    ['parent_missing', g => { g.nodes[0].parent_id = 'invented-' + KEY; }],
    ['parent_level', g => { g.nodes[0].parent_id = 'synthetic-node'; }],
    ['parent_backlink', g => { g.nodes[1].children_ids = []; }],
    ['primary_mismatch', g => { g.nodes[0].memberships = [{ parent_id: 'topic', role: 'primary' }]; }],
    ['membership_missing', g => { g.nodes[0].memberships = [{ parent_id: 'invented-' + KEY, role: 'secondary' }]; }],
    ['membership_level', g => { g.nodes[1].memberships = [{ parent_id: 'synthetic-node', role: 'secondary' }]; }],
    ['membership_backlink', g => { g.nodes[1].memberships = [{ parent_id: 'arc', role: 'secondary' }]; }],
    ['secondary_duplicate', g => { g.nodes[0].memberships = [{ parent_id: 'idea', role: 'secondary' }]; }],
    ['child_missing', g => { g.nodes[4].children_ids.push('invented-' + KEY); }],
    ['child_level', g => { g.nodes[4].children_ids.push('arc'); }],
    ['child_backlink', g => { g.nodes[4].children_ids.push('synthetic-node'); }],
  ])('reports hierarchy rule %s without changing public refusal or admission', async (rule, mutate) => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(hierarchyCompletion(mutate)), { status: 200 }));
    const response = await worker.fetch(request(), env), body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toEqual({ code: 'invalid_completion', error: 'OpenRouter did not return a complete source-linked map. The attempt remains counted; no map was saved.' });
    expect(logged.mock.calls).toEqual([['[openrouter] generation failed', {
      code: 'invalid_completion', validationStage: 'hierarchy', validationRule: rule,
    }]]);
    expect(JSON.stringify({ body, logs: logged.mock.calls })).not.toMatch(/synthetic-|utterance-0001|invented-/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts WHERE completed_at IS NULL AND recovery_released_at IS NULL').get().n).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid overlapping hierarchy without logging or saving', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(hierarchyCompletion(g => {
      g.nodes[1].memberships = [{ parent_id: 'topic', role: 'primary' }, { parent_id: 'topic-alt', role: 'secondary' }];
      g.nodes.push({ ...g.nodes[2], id: 'topic-alt', children_ids: ['idea'] });
      g.nodes[3].children_ids.push('topic-alt');
    })), { status: 200 }));
    const response = await worker.fetch(request(), env), body = await response.json();
    expect(response.status).toBe(200);
    expect(body.artifact.graph_data.find(node => node.id === 'idea').memberships).toEqual([
      { parent_id: 'topic', role: 'primary' }, { parent_id: 'topic-alt', role: 'secondary' },
    ]);
    expect(logged).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT completed_at FROM lct_openrouter_attempts').get().completed_at).toBeGreaterThan(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
  });

  it('replaces untrusted diagnostic rules with a fixed unknown label', () => {
    logOpenRouterFailure(env, 'invalid_completion', 'hierarchy', 'private-' + KEY);
    expect(logged.mock.calls).toEqual([['[openrouter] generation failed', {
      code: 'invalid_completion', validationStage: 'hierarchy', validationRule: 'unknown',
    }]]);
  });

  it('keeps diagnostics off by default', async () => {
    delete env.LCT_OPENROUTER_DEBUG;
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(rejectedGraph(value => { value.nodes = []; })), { status: 200 }));
    expect((await worker.fetch(request(), env)).status).toBe(502); expect(logged).not.toHaveBeenCalled();
  });

  it('emits nothing for successful conversion', async () => {
    expect((await worker.fetch(request(), env)).status).toBe(200); expect(logged).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT completed_at FROM lct_openrouter_attempts').get().completed_at).toBeGreaterThan(0);
  });

  it.each(['invalid_completion', 'generation_failed'])('a throwing diagnostic sink preserves %s and the unresolved attempt', async code => {
    logged.mockImplementation(() => { throw new Error('private-log-sink-' + KEY); });
    if (code === 'invalid_completion') fetch.mockResolvedValueOnce(new Response(JSON.stringify(rejectedGraph(value => { value.nodes = []; })), { status: 200 }));
    else fetch.mockRejectedValueOnce(Object.assign(new Error('private-provider-' + KEY), { name: KEY, validationStage: KEY }));
    const response = await worker.fetch(request(), env), body = await response.json();
    expect(response.status).toBe(code === 'invalid_completion' ? 502 : 503); expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(logged.mock.calls).toEqual([['[openrouter] generation failed', { code,
      validationStage: code === 'invalid_completion' ? 'graph_shape' : 'unknown' }]]);
    expect(sqlite.prepare('SELECT completed_at FROM lct_openrouter_attempts').get().completed_at).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
