// @vitest-environment node
// Test intent: tests/intent/tier-safe-generation.md and lct_app/tests/intent/sites-anthropic.md. All source is synthetic.
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
const request = (backend, headers = {}) => new Request(`${SITE}/api/cloud/${backend}/generate`, { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', [`x-lct-${backend}-consent`]: 'generate-v1', ...headers },
  body: JSON.stringify({ source }) });
let sqlite, env, worker, responseGraph;
const anthropicReply = (stop_reason = 'end_turn', extraBlocks = []) => ({
  type: 'message', role: 'assistant', stop_reason, content: [
    { type: 'thinking', thinking: 'Synthetic internal reasoning.' },
    { type: 'text', text: JSON.stringify(responseGraph) },
    ...extraBlocks,
  ],
});

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
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key', LCT_ANTHROPIC_MODEL: 'claude-synthetic',
    LCT_ANTHROPIC_ENABLED: 'true', LCT_ANTHROPIC_PROJECT_BUDGET_CONFIRMED: 'true',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  responseGraph = graph();
  vi.stubGlobal('fetch', vi.fn(async url => Response.json(url === 'https://api.anthropic.com/v1/messages' ? anthropicReply()
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(responseGraph) } }] })));
  // Isolated actual migration schema and intercepted network precede Worker import.
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('tier-safe generation on the public Worker backend routes', () => {
  it.each(['openrouter', 'gemini', 'anthropic'])('returns source-linked portable threads through %s with one counted request and no cloud content', async backend => {
    const response = await worker.fetch(request(backend), env), body = await response.json();
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0], wire = JSON.parse(options.body);
    const endpoints = { openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      anthropic: 'https://api.anthropic.com/v1/messages' };
    const directClaude = backend === 'anthropic';
    expect(url).toBe(endpoints[backend]);
    const schema = directClaude ? wire.output_config.format.schema : wire.response_format.json_schema.schema;
    expect(schema.properties.hierarchy_format.enum).toEqual(['tiered-parent-links-v2']);
    expect(wire.max_tokens).toBe(8192);
    const evidence = wire.messages.at(-1).content;
    expect(JSON.parse(evidence)).toEqual({ transcription_complete: true,
      utterances: [{ id: 'utterance-0001', text: source.finalTokens[0].text }] });
    if (directClaude) {
      expect(options).toMatchObject({ method: 'POST', redirect: 'manual',
        headers: { 'x-api-key': 'synthetic-anthropic-key', 'anthropic-version': '2026-10-21', 'Content-Type': 'application/json' } });
      expect(Object.keys(options.headers)).not.toContain('Authorization');
      expect(wire).toMatchObject({ model: 'claude-synthetic', system: expect.stringContaining('untrusted evidence'), stream: false,
        output_config: { format: { type: 'json_schema' } }, messages: [{ role: 'user', content: evidence }] });
      expect(wire).not.toHaveProperty('provider');
      expect(wire).not.toHaveProperty('tools');
      expect(wire).not.toHaveProperty('response_format');
      expect(JSON.stringify(schema)).not.toContain('"maxItems"');
      expect(JSON.stringify(body)).not.toMatch(/Synthetic internal reasoning|synthetic-anthropic-key/);
    }
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

  it.each(['openrouter', 'gemini', 'anthropic'])('refuses a wrong-tier %s parent while retaining the failed holder without retry', async backend => {
    responseGraph.nodes[0].parent_id.semantic_level = 1;
    const response = await worker.fetch(request(backend), env), body = await response.json();
    expect(response.status).toBe(502); expect(body.code).toBe('invalid_completion');
    expect(body.artifact).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT completed_at, recovery_released_at FROM lct_openrouter_attempts').all())
      .toEqual([{ completed_at: null, recovery_released_at: null }]);
  });
});

describe('direct Anthropic admission and health', () => {
  const readiness = () => worker.fetch(new Request(SITE + '/api/cloud/anthropic/status'), env);
  const health = () => worker.fetch(new Request(SITE + '/api/cloud/health/anthropic'), env);
  const attempts = () => sqlite.prepare('SELECT completed_at, max_output_tokens FROM lct_openrouter_attempts').all();

  it('requires recipient-specific consent, an explicit model, key and budget confirmation', async () => {
    expect((await worker.fetch(request('anthropic', { 'x-lct-anthropic-consent': '',
      'x-lct-openrouter-consent': 'generate-v1', 'x-lct-gemini-consent': 'generate-v1' }), env)).status).toBe(403);
    expect((await worker.fetch(request('anthropic', { origin: 'https://different-origin.example' }), env)).status).toBe(403);
    for (const name of ['ANTHROPIC_API_KEY', 'LCT_ANTHROPIC_MODEL', 'LCT_ANTHROPIC_ENABLED', 'LCT_ANTHROPIC_PROJECT_BUDGET_CONFIRMED']) {
      const value = env[name];
      delete env[name];
      expect((await (await readiness()).json()).enabled).toBe(false);
      expect((await worker.fetch(request('anthropic'), env)).status).toBe(503);
      env[name] = value;
    }
    env.LCT_OPENROUTER_AUDIENCE = 'authenticated';
    expect((await worker.fetch(request('anthropic'), env)).status).toBe(401);
    expect(attempts()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses existing admission counts and interval across providers without its own quota', async () => {
    vi.useFakeTimers();
    env.LCT_OPENROUTER_MAX_REQUESTS = '2';
    expect((await worker.fetch(request('gemini'), env)).status).toBe(200);
    expect((await worker.fetch(request('anthropic'), env)).status).toBe(429);
    vi.setSystemTime(Date.now() + 10_001);
    expect((await worker.fetch(request('anthropic'), env)).status).toBe(200);
    vi.setSystemTime(Date.now() + 10_001);
    expect((await worker.fetch(request('openrouter'), env)).status).toBe(429);
    expect((await (await readiness()).json()).available).toBe(false);
    expect(attempts()).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the existing long transcript output ceiling for direct Claude', async () => {
    env.LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS = '12000';
    const longSource = { ...source, finalTokens: [{ ...source.finalTokens[0], endMs: 301_000 }] };
    const response = await worker.fetch(new Request(SITE + '/api/cloud/anthropic/generate', {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-anthropic-consent': 'generate-v1' },
      body: JSON.stringify({ source: longSource, model: 'claude-unapproved', max_tokens: 65_000 }),
    }), env);
    expect(response.status).toBe(200);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: 'claude-synthetic', max_tokens: 12_000 });
    expect(attempts()).toMatchObject([{ max_output_tokens: 12_000 }]);
  });

  it('checks a direct model without OpenRouter credentials or generation traffic', async () => {
    delete env.OPENROUTER_API_KEY;
    delete env.LCT_OPENROUTER_MODEL;
    delete env.LCT_OPENROUTER_PROVIDER;
    delete env.LCT_OPENROUTER_ENABLED;
    const status = await (await readiness()).json();
    expect(status).toMatchObject({ enabled: true, available: true, provider: 'Anthropic', model: 'claude-synthetic', fallback_models: [] });
    expect(JSON.stringify(status)).not.toContain('synthetic-anthropic-key');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ type: 'model', id: 'claude-synthetic-20261124',
      max_tokens: 16_384, capabilities: { structured_outputs: { supported: true } } }));
    expect(await (await health()).json()).toMatchObject({ service: 'anthropic', reachable: true, allowance: 'unknown' });
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models/claude-synthetic',
      expect.objectContaining({ method: 'GET', redirect: 'manual',
        headers: { 'x-api-key': 'synthetic-anthropic-key', 'anthropic-version': '2026-10-21' } }));
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    expect(attempts()).toEqual([]);
  });

  it.each(['max_tokens', 'refusal', 'tool_use'])('keeps an unusable %s completion counted without retry', async stopReason => {
    fetch.mockResolvedValueOnce(Response.json(anthropicReply(stopReason)));
    const response = await worker.fetch(request('anthropic'), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'invalid_completion' });
    expect(attempts()).toEqual([{ completed_at: null, max_output_tokens: 8192 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected output blocks and does not act on tool requests', async () => {
    fetch.mockResolvedValueOnce(Response.json(anthropicReply('end_turn', [{ type: 'tool_use', name: 'unapproved' }])));
    const response = await worker.fetch(request('anthropic'), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'invalid_completion' });
    expect(attempts()[0].completed_at).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an upstream redirect counted without forwarding its destination or body', async () => {
    fetch.mockResolvedValueOnce(new Response('private provider message', { status: 302,
      headers: { location: 'https://different-origin.example' } }));
    const response = await worker.fetch(request('anthropic'), env);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'provider_refused', upstream_status: 302 });
    expect(JSON.stringify(body)).not.toMatch(/private provider message|different-origin/);
    expect(attempts()[0].completed_at).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('ordered settings generation', () => {
  const orderedRequest = (routes, init = {}) => new Request(SITE + '/api/cloud/map/generate', {
    method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1', ...init.headers },
    body: JSON.stringify({ source, routes, guidance: 'Follow changes of mind.' }),
  });
  const count = () => sqlite.prepare('SELECT COUNT(*) AS total FROM lct_openrouter_attempts').get().total;

  it('uses a consented fallback on a definitive key refusal under one shared admission', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    const routes = [{ backend: 'anthropic', key: 'personal-test-key', model: 'claude-test-personal' }, { backend: 'gemini' }];
    fetch.mockResolvedValueOnce(new Response('private refusal details', { status: 401 }));
    const response = await worker.fetch(orderedRequest(routes), env);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ backend: 'gemini', model: env.LCT_GEMINI_MODEL, artifact: { full_transcript: source.finalTokens[0].text } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']);
    expect(fetch.mock.calls[0][1].headers['x-api-key']).toBe('personal-test-key');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: 'claude-test-personal', system: expect.stringContaining('Follow changes of mind.') });
    expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content).toContain('Follow changes of mind.');
    expect(JSON.stringify(payload)).not.toMatch(/personal-test-key|private refusal details/);
    expect(count()).toBe(1);
  });

  it.each([500, 529])('stops the whole order after uncertain HTTP %d', async status => {
    fetch.mockResolvedValueOnce(new Response('unknown outcome', { status }));
    const response = await worker.fetch(orderedRequest([{ backend: 'anthropic' }, { backend: 'gemini' }]), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'provider_refused', upstream_status: status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(count()).toBe(1);
  });

  it('does not send to another recipient after an OpenRouter 503', async () => {
    fetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const response = await worker.fetch(orderedRequest([{ backend: 'openrouter' }, { backend: 'gemini' }]), env);
    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(count()).toBe(1);
  });

  it('never substitutes the Site secret when a personal route is incomplete or disabled', async () => {
    const routes = [{ backend: 'anthropic', key: 'personal-key', model: 'claude-test' }];
    expect((await worker.fetch(orderedRequest(routes), env)).status).toBe(503);
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    expect((await worker.fetch(orderedRequest([{ backend: 'anthropic', key: 'personal-key' }]), env)).status).toBe(503);
    expect((await worker.fetch(orderedRequest(routes, { headers: { 'x-lct-map-consent': '' } }), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(count()).toBe(0);
  });

  it('checks only provider metadata for a personal key and returns available models', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    fetch.mockResolvedValueOnce(Response.json({ data: [{ type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' }] }));
    const response = await worker.fetch(new Request(SITE + '/api/cloud/providers/check', {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-key-check': 'check-v1' },
      body: JSON.stringify({ backend: 'anthropic', key: 'personal-key' }),
    }), env);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models?limit=100',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'personal-key' }), redirect: 'manual' }));
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    const text = await response.text();
    expect(text).not.toContain('personal-key');
    expect(JSON.parse(text).models).toEqual([{ id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' }]);
    expect(count()).toBe(0);
  });

  it('supports multiple ordered models from the same provider and optional OpenRouter upstream slug', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    const routes = [
      { backend: 'openrouter', key: 'or-personal-key', model: 'anthropic/claude-sonnet-4.5' },
      { backend: 'anthropic', key: 'ant-bad-key', model: 'claude-sonnet-4-5-20250929' },
      { backend: 'openrouter', key: 'or-personal-key', model: 'google/gemini-2.5-pro' },
    ];
    fetch
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    const response = await worker.fetch(orderedRequest(routes), env);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ backend: 'openrouter', model: 'google/gemini-2.5-pro' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    const thirdBody = JSON.parse(fetch.mock.calls[2][1].body);
    expect(thirdBody.model).toBe('google/gemini-2.5-pro');
    expect(thirdBody.provider.only).toBeUndefined();
    expect(thirdBody.provider.data_collection).toBe('deny');
    expect(count()).toBe(1);
  });
});
