// @vitest-environment node
// Test intent: tests/intent/tier-safe-generation.md. All source is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readThreadsFile } from '../threadsArtifact.js';

const SITE = 'https://synthetic-tiered.example.chatgpt.site';
const source = { recordingId: 'synthetic-import', startedAt: Date.UTC(2026, 9, 21), complete: true,
  finalTokens: [{ text: 'A synthetic garden needs water.', speaker: 'S1', startMs: 0, endMs: 2000 }] };
const graph = () => ({ hierarchy_format: 'tiered-parent-links-v2',
  nodes: [1, 2].map(level => ({ id: 'garden', semantic_level: level,
    semantic_type: level === 1 ? 'chunk' : 'idea', node_name: 'Synthetic garden', summary: 'Water and care.',
    source_excerpt: '', source_ref: { utterance_ids: ['utterance-0001'] },
    parent_id: level === 1 ? { semantic_level: 2, id: 'garden' } : null,
    secondary_parent_ids: [], thread_id: null })),
  edges: [], metadata: { conversation_title: 'Synthetic garden', executive_summary: 'Water and care.' },
  conversation_threads: [{ id: 'garden', title: 'Care',
    steps: [{ moment_id: { semantic_level: 1, id: 'garden' }, evidence_utterance_ids: ['utterance-0001'] }] }] });
const request = backend => new Request(`${SITE}/api/cloud/${backend}/generate`, { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', [`x-lct-${backend}-consent`]: 'generate-v1' },
  body: JSON.stringify({ source }) });
let sqlite, env, worker, responseGraph;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n).toBe(0);
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_OPENROUTER_MODEL: 'synthetic/model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
    LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192',
    OPENROUTER_API_KEY: 'synthetic-key', GEMINI_API_KEY: 'synthetic-gemini-key',
    LCT_GEMINI_MODEL: 'gemini-synthetic', LCT_GEMINI_ENABLED: 'true', LCT_GEMINI_PROJECT_BUDGET_CONFIRMED: 'true',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  responseGraph = graph();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify(responseGraph) } }] }), { status: 200 })));
  // Isolated actual migration schema and intercepted network precede Worker import.
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('tier-safe generation on both public Worker backend routes', () => {
  it.each(['openrouter', 'gemini'])('returns source-linked portable threads through %s with one counted request and no cloud content', async backend => {
    const response = await worker.fetch(request(backend), env), body = await response.json();
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0], wire = JSON.parse(options.body);
    expect(url).toBe(backend === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions');
    expect(wire.response_format.json_schema.schema.properties.hierarchy_format.enum).toEqual(['tiered-parent-links-v2']);
    expect(wire.max_tokens).toBe(8192);
    expect(wire.messages[1].content).not.toMatch(/synthetic-import|S1|startMs/);
    const opened = await readThreadsFile(new File([JSON.stringify(body.artifact)], 'synthetic.threads'));
    expect(opened.full_transcript).toBe(source.finalTokens[0].text);
    expect(opened.graph_data[0]).toMatchObject({ id: '1:garden', parent_id: '2:garden',
      source_ref: { utterance_ids: ['utterance-0001'] } });
    expect(opened.conversation_threads[0].steps[0].moment_id).toBe('1:garden');
    const rows = sqlite.prepare('SELECT * FROM lct_openrouter_attempts').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.request_id, max_output_tokens: 8192, recovery_released_at: null });
    expect(rows[0].completed_at).toBeGreaterThan(0);
    for (const table of ['lct_cloud_files', 'lct_public_threads']) expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
  });

  it.each(['openrouter', 'gemini'])('refuses a wrong-tier %s parent while retaining the failed holder without retry', async backend => {
    responseGraph.nodes[0].parent_id.semantic_level = 1;
    const response = await worker.fetch(request(backend), env), body = await response.json();
    expect(response.status).toBe(502); expect(body.code).toBe('invalid_completion');
    expect(body.artifact).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT completed_at, recovery_released_at FROM lct_openrouter_attempts').all())
      .toEqual([{ completed_at: null, recovery_released_at: null }]);
  });
});
