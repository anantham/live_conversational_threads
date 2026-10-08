// @vitest-environment node
// Test intent: tests/intent/sites-openrouter.md. Synthetic data; no live provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

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
    expect(logged.mock.calls).toEqual([['[openrouter] generation failed', { code: 'invalid_completion', validationStage: stage }]]);
    expect(JSON.stringify({ body, logs: logged.mock.calls })).not.toMatch(/synthetic-|utterance-0001|invented-|private-path|private-edge/);
    const rows = sqlite.prepare('SELECT * FROM lct_openrouter_attempts').all();
    expect(rows).toHaveLength(1); expect(rows[0].completed_at).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
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
