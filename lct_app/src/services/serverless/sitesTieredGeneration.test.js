// @vitest-environment node
// Test intent: tests/intent/tier-safe-generation.md and lct_app/tests/intent/sites-anthropic.md. All source is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readThreadsFile } from '../threadsArtifact.js';
import { runLongTranscriptPipeline } from '../cloud/longTranscriptPipeline.js';

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
    expect(schema.properties.hierarchy_format.enum).toEqual(['tiered-ranges-v3']);
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

  it('tells the browser a truncated Claude map hit the output cap, without completion text', async () => {
    const truncated = { ...anthropicReply('max_tokens'), usage: { input_tokens: 9100, output_tokens: 8192 } };
    truncated.content[1].text = '{"nodes":[{"id":"private-truncated-' ;
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(truncated), { status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_011SyntheticTruncated' } }));
    const response = await worker.fetch(request('anthropic'), env), body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toEqual({ code: 'invalid_completion',
      error: 'Anthropic did not return a complete source-linked map. The attempt remains counted; no map was saved.',
      validation_stage: 'choice_finish', stop_reason: 'max_tokens', output_tokens: 8192, max_output_tokens: 8192,
      upstream_request_id: 'req_011SyntheticTruncated',
      attempts: [{ backend: 'anthropic', task: 'map', max_output_tokens: 8192, outcome: 'rejected', stage: 'choice_finish',
        stop_reason: 'max_tokens', input_tokens: 9100, output_tokens: 8192, request_id: 'req_011SyntheticTruncated', duration_ms: expect.any(Number) }] });
    expect(JSON.stringify(body)).not.toMatch(/private-truncated|Synthetic internal reasoning|synthetic-anthropic-key/);
    expect(attempts()).toEqual([{ completed_at: null, max_output_tokens: 8192 }]);
  });

  it('names the hierarchy rule when a complete Claude map breaks a tier rule', async () => {
    responseGraph.nodes[0].parent_id.semantic_level = 1;
    fetch.mockResolvedValueOnce(Response.json({ ...anthropicReply(), usage: { output_tokens: 640 } }));
    const body = await (await worker.fetch(request('anthropic'), env)).json();
    expect(body).toMatchObject({ code: 'invalid_completion', validation_stage: 'hierarchy', stop_reason: 'end_turn', output_tokens: 640 });
    expect(typeof body.validation_rule).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/Synthetic garden|Water and care/);
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
    fetch.mockResolvedValueOnce(Response.json({ data: [
      { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', lifecycle: 'active' },
      { type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', lifecycle: 'deprecated' },
      { type: 'model', id: 'claude-no-json', capabilities: { structured_outputs: { supported: false } } },
    ] }));
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
    expect(JSON.parse(text).models).toEqual([{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]);
    expect(count()).toBe(0);
  });

  it('returns a safe Anthropic model-list refusal and request ID without blaming the key for HTTP 400', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Private provider error body.' } },
      { status: 400, headers: { 'request-id': 'req_modelcheck123' } }));
    const response = await worker.fetch(new Request(SITE + '/api/cloud/providers/check', {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-key-check': 'check-v1' },
      body: JSON.stringify({ backend: 'anthropic', key: 'personal-key' }),
    }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'The provider’s model check returned HTTP 400. Anthropic request ID req_modelcheck123.',
    });
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

it('builds one source-linked map across seven transcript windows through the public Claude route', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  env.LCT_OPENROUTER_MAX_REQUESTS = '10';
  const startedAt = source.startedAt;
  const turns = Array.from({ length: 56 }, (_, index) => ({
    text: (index ? '\n' : '') + `Window test turn ${index + 1}.`,
    speaker: index % 2 ? 'S2' : 'S1',
    startMs: index * 100_000,
    endMs: (index + 1) * 100_000,
  }));
  const orderedSource = { recordingId: 'seven-window-import', startedAt, complete: true, finalTokens: turns };
  const routes = [{ backend: 'anthropic', key: 'synthetic-personal-key', model: 'claude-synthetic' }];
  const dispatched = [];
  vi.spyOn(Date, 'now').mockImplementation(() => startedAt + dispatched.length * 10_500);
  fetch.mockImplementation(async (url, options) => {
    if (url === '/api/cloud/map/generate') {
      dispatched.push(JSON.parse(options.body).source.recordingId);
      return worker.fetch(new Request(SITE + url, { ...options, headers: { ...options.headers, origin: SITE } }), env);
    }
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const wire = JSON.parse(options.body);
    expect(wire.model).toBe('claude-synthetic');
    const node = wire.output_config.format.schema.properties.nodes.items;
    expect(node.type).toBe('object');
    // One node shape; chunk ranges and higher-tier nulls are enforced after decoding.
    expect(node.properties.source_range.anyOf.map(branch => branch.type)).toEqual(['object', 'null']);
    expect(node.properties.thread_id).toBeUndefined();
    return Response.json(anthropicReply());
  });

  const result = await runLongTranscriptPipeline({ source: orderedSource, routes, intervalMs: 0 });
  expect(result.windowCount).toBe(7);
  expect(result.bundle.full_transcript).toBe(turns.map(turn => turn.text).join(''));
  expect(result.bundle.graph_data).toHaveLength(14);
  expect(result.bundle.graph_data.find(node => node.id === 'w7-1:garden')).toMatchObject({
    parent_id: 'w7-2:garden', memberships: [{ parent_id: 'w7-2:garden', role: 'primary' }],
  });
  expect(result.bundle.graph_data.filter(node => node.semantic_level === 1).map(node => node.source_ref.utterance_ids[0]))
    .toEqual(['utterance-0001', 'utterance-0010', 'utterance-0019', 'utterance-0028', 'utterance-0037', 'utterance-0046', 'utterance-0055']);
  expect(dispatched).toEqual(Array.from({ length: 7 }, (_, index) => `seven-window-import-w${index + 1}`));
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts WHERE completed_at IS NOT NULL').get().n).toBe(7);
});

describe('Claude schema diagnostic', () => {
  const model = 'claude-sonnet-5-5';
  const key = 'synthetic-diagnostic-key';
  const id1 = 'req_011SyntheticFirst';
  const id2 = 'req_011SyntheticSecond';
  const diagnostic = (body = { key, model }, consent = 'test-v1') => new Request(SITE + '/api/cloud/map/claude-diagnostic', {
    method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-claude-diagnostic': consent },
    body: JSON.stringify(body),
  });
  const rows = () => sqlite.prepare('SELECT max_output_tokens, completed_at FROM lct_openrouter_attempts').all();

  it('compares both schemas on identical synthetic text, with the normal long map cap and one admission', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    env.LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS = '12000';
    fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"status":"ready"}' }] }, { headers: { 'request-id': id1 } }));
    fetch.mockResolvedValueOnce(Response.json(anthropicReply(), { headers: { 'request-id': id2 } }));
    const response = await worker.fetch(diagnostic(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ diagnostic: 'passed', model, minimal_request_id: id1, map_request_id: id2 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://api.anthropic.com/v1/messages'));
    const [minimal, full] = fetch.mock.calls.map(([, options]) => {
      expect(options.headers['x-api-key']).toBe(key);
      return JSON.parse(options.body);
    });
    expect(minimal.model).toBe(model);
    expect(full.model).toBe(model);
    expect(minimal.max_tokens).toBeLessThan(full.max_tokens);
    expect(full.max_tokens).toBe(12_000);
    expect(minimal.messages).toEqual(full.messages);
    expect(JSON.parse(full.messages[0].content).utterances).toHaveLength(3);
    expect(minimal.output_config.format.schema.properties).toHaveProperty('status');
    expect(full.output_config.format.schema.properties).toHaveProperty('nodes');
    expect(rows()).toEqual([{ max_output_tokens: 12_000, completed_at: expect.any(Number) }]);
  });

  it('retests only the compact production map schema in map-only mode', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    fetch.mockResolvedValueOnce(Response.json(anthropicReply(), { headers: { 'request-id': id2 } }));
    const response = await worker.fetch(diagnostic({ key, model, mode: 'map' }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ diagnostic: 'passed', model, map_request_id: id2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(fetch.mock.calls[0][1].body);
    const node = wire.output_config.format.schema.properties.nodes.items;
    expect(node).toMatchObject({ type: 'object', properties: {
      semantic_level: { enum: [1, 2, 3, 4, 5] },
      source_range: { anyOf: [{ type: 'object', required: ['from', 'to'] }, { type: 'null' }] },
    } });
    expect(node).not.toHaveProperty('anyOf');
    expect(rows()).toEqual([{ max_output_tokens: 8192, completed_at: expect.any(Number) }]);
  });

  it.each([
    ['a mismatched tier name', graph => { graph.nodes[0].semantic_type = 'arc'; }],
    ['an unknown source utterance', graph => { graph.nodes[0].source_ref.utterance_ids = ['unknown']; }],
  ])('still refuses %s through the Claude map route', async (_, invalidate) => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    invalidate(responseGraph);
    const response = await worker.fetch(diagnostic({ key, model, mode: 'map' }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'invalid_completion', diagnostic_stage: 'map' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([{ max_output_tokens: 8192, completed_at: null }]);
  });

  it('distinguishes a schema failure from a successful minimal check without returning raw text', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn' }, { headers: { 'request-id': id1 } }));
    fetch.mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error',
      message: 'Schema is too complex for compilation. Other unsafe details.' }, request_id: id2 }, { status: 400 }));
    const response = await worker.fetch(diagnostic(), env);
    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload).toMatchObject({ diagnostic_stage: 'map', upstream_status: 400,
      upstream_reason: 'anthropic_schema', upstream_request_id: id2, minimal_request_id: id1 });
    expect(JSON.stringify(payload)).not.toContain('unsafe details');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([{ max_output_tokens: 8192, completed_at: null }]);
  });

  it('stops after a minimal spend-limit rejection and refuses user transcript input', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    expect((await worker.fetch(diagnostic({ key, model, source }), env)).status).toBe(400);
    expect((await worker.fetch(diagnostic({ key, model }, 'generate-v1'), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    fetch.mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error',
      message: 'Workspace spend limit reached.' }, request_id: 'unsafe secret' }, { status: 400 }));
    const response = await worker.fetch(diagnostic(), env);
    const payload = await response.json();
    expect(payload).toMatchObject({ diagnostic_stage: 'minimal', upstream_reason: 'anthropic_spend_limit' });
    expect(payload).not.toHaveProperty('upstream_request_id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('adds safe Anthropic refusal details to an ordinary map without trying a second recipient', async () => {
    env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
    fetch.mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error',
      message: 'Bad output_config.format for this schema' } }, { status: 400, headers: { 'request-id': id1 } }));
    const req = new Request(SITE + '/api/cloud/map/generate', {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
      body: JSON.stringify({ source, routes: [{ backend: 'anthropic', key, model }, { backend: 'gemini' }] }),
    });
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ upstream_reason: 'anthropic_schema', upstream_request_id: id1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });
});

// Intent: lct_app/tests/intent/glance-detail-generation.md — the tasks run through the ordered Worker route.
it('runs a skeleton glance through the public Claude route with its own schema, prompt and glossary', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  const skeleton = { hierarchy_format: 'skeleton-ranges-v1', glossary: [{ canonical: 'Mirela', variants: ['Mirella'] }],
    metadata: { conversation_title: 'Garden', executive_summary: 'Water.' }, edges: [], conversation_threads: [],
    nodes: [{ id: 'garden', semantic_level: 3, semantic_type: 'topic', node_name: 'Garden', summary: 'Water.', salience: 'core',
      source_ranges: [{ from: 'utterance-0001', to: 'utterance-0001' }], parent_id: null, secondary_parent_ids: [] }] };
  fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(skeleton) }] }));
  const response = await worker.fetch(new Request(SITE + '/api/cloud/map/generate', { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
    body: JSON.stringify({ source, task: 'skeleton', routes: [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }] }) }), env);
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ task: 'skeleton', glossary: [{ canonical: 'Mirela', variants: ['Mirella'] }] });
  expect(body.artifact.graph_data).toEqual([expect.objectContaining({ id: '3:garden', salience: 'core',
    source_ref: { utterance_ids: ['utterance-0001'] } })]);
  const wire = JSON.parse(fetch.mock.calls[0][1].body);
  expect(wire.system).toContain('Glance over the whole conversation');
  expect(wire.output_config.format.schema.properties.nodes.items.properties.semantic_level.enum).toEqual([3, 4, 5]);
});

it('refuses a detail task without segment topics before any provider call', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  const response = await worker.fetch(new Request(SITE + '/api/cloud/map/generate', { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
    body: JSON.stringify({ source, task: 'detail', routes: [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }] }) }), env);
  expect(response.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it('runs an audit task through the ordered route and returns findings, not a map', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  const reply = { format: 'audit-v1', contradictions: [], entity_splits: [],
    independent_points: [{ kind: 'decision', note: 'Water at seven.', range: { from: 'utterance-0001', to: 'utterance-0001' }, represented_by: null }] };
  fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(reply) }] }));
  const response = await worker.fetch(new Request(SITE + '/api/cloud/map/generate', { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
    body: JSON.stringify({ source, task: 'audit', nodes: [{ id: '3:garden', semantic_level: 3, node_name: 'Garden', summary: 'Water.',
      ranges: [{ from: 'utterance-0001', to: 'utterance-0001' }] }],
    routes: [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }] }) }), env);
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ task: 'audit', findings: [{ kind: 'missed', point_kind: 'decision', utterance_ids: ['utterance-0001'] }] });
  expect(body.artifact).toBeUndefined();
  const wire = JSON.parse(fetch.mock.calls[0][1].body);
  expect(JSON.parse(wire.messages[0].content).map_nodes[0].id).toBe('3:garden');
  expect(wire.system).toContain('independently of the map');
});

// Review findings 3, 6, 11.
it('accepts an audit with no covering nodes but rejects malformed audit nodes and tasks on legacy routes', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  const post = (path, body, consent = 'x-lct-map-consent') => worker.fetch(new Request(SITE + path, { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', [consent]: 'generate-v1' }, body: JSON.stringify(body) }), env);
  const routes = [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }];
  fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ format: 'audit-v1', independent_points: [], contradictions: [], entity_splits: [] }) }] }));
  expect((await post('/api/cloud/map/generate', { source, task: 'audit', nodes: [], routes })).status).toBe(200);
  const bad = [{ id: '3:a', semantic_level: 3, node_name: 'A', ranges: [{ from: 'anything goes', to: 'utterance-0001' }] }];
  expect((await post('/api/cloud/map/generate', { source, task: 'audit', nodes: bad, routes })).status).toBe(400);
  const dup = [1, 2].map(() => ({ id: '3:a', semantic_level: 3, node_name: 'A', ranges: [{ from: 'utterance-0001', to: 'utterance-0001' }] }));
  expect((await post('/api/cloud/map/generate', { source, task: 'audit', nodes: dup, routes })).status).toBe(400);
  expect((await post('/api/cloud/map/generate', { source, task: 'detail', topics: [{ id: 'a', node_name: 'A' }], glossary: 'not-a-list', routes })).status).toBe(400);
  expect((await post('/api/cloud/anthropic/generate', { source, task: 'audit' }, 'x-lct-anthropic-consent')).status).toBe(400);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports an OpenRouter cut-off as max_tokens so the browser can split', async () => {
  fetch.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"nodes":[' } }],
    usage: { completion_tokens: 8192 } }));
  const body = await (await worker.fetch(request('openrouter'), env)).json();
  expect(body).toMatchObject({ code: 'invalid_completion', validation_stage: 'choice_finish', stop_reason: 'max_tokens', output_tokens: 8192 });
});

// Intent: a provider that cannot be reached is named, with what was tried, never reported as a storage fault.
it('names an unreachable provider and returns the attempt that was in flight', async () => {
  env.LCT_PERSONAL_PROVIDERS_ENABLED = 'true';
  fetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  const response = await worker.fetch(new Request(SITE + '/api/cloud/map/generate', { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
    body: JSON.stringify({ source, task: 'skeleton', routes: [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }] }) }), env);
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body).toMatchObject({ code: 'provider_unreachable', attempts: [{ backend: 'anthropic', model: 'claude-synthetic', task: 'skeleton',
    outcome: 'network_error', error_name: 'TypeError', error_cause: 'ECONNRESET' }] });
  expect(body.error).toMatch(/could not be reached \(TypeError ECONNRESET\)/);
});
