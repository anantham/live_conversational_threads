// @vitest-environment node
// Test intent (streamed map generation on the Sites Worker; all source and keys are synthetic):
// - a reply that breaks off mid-read is reported as an interrupted reply, not as a provider that "could not be reached";
// - a client that cancels mid-reply records a cancelled attempt, never a rejected (validated and failed) one;
// - when the browser goes away, the Worker cancels its read of the provider stream;
// - the 2 MiB stream bound applies to the reply text, not to the SSE envelope around it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readProviderStream } from '../../../sites/streamParser.js';

const SITE = 'https://synthetic-stream.example.chatgpt.site';
const source = { recordingId: 'synthetic-stream', startedAt: Date.UTC(2026, 9, 21), complete: true,
  finalTokens: [{ text: 'A synthetic orchard needs pruning.', speaker: 'S1', startMs: 0, endMs: 2000 }] };
const routes = [{ backend: 'anthropic', key: 'sk-ant-synthetic-personal-key-000000', model: 'claude-synthetic' }];
const encoder = new TextEncoder();
const sse = event => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const delta = text => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
let sqlite, env, worker;

function streamRequest(signal) {
  return new Request(SITE + '/api/cloud/map/generate', { method: 'POST', signal,
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1', accept: 'text/event-stream' },
    body: JSON.stringify({ source, task: 'skeleton', routes }) });
}

/** Reads the Worker's SSE reply into events, optionally acting after a named event arrives. */
async function readEvents(response, { after, act } = {}) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const events = [];
  let buffer = '', acted = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const name = block.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null');
      events.push({ name, data });
      if (!acted && name === after) { acted = true; await act(); }
    }
  }
  return events;
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_OPENROUTER_MODEL: 'synthetic/model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
    LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public',
    LCT_OPENROUTER_MAX_REQUESTS: '4', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192',
    OPENROUTER_API_KEY: 'synthetic-key', LCT_PERSONAL_PROVIDERS_ENABLED: 'true',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn());
  worker = (await import('../../../sites/worker.js')).default;
}, 30_000); // The first Worker import transforms the whole Sites bundle.
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('streamed map generation on the Worker', () => {
  it('reports a reply that breaks off mid-read as interrupted, not unreachable', async () => {
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: 'message_start', message: { usage: { input_tokens: 900 } } }));
        controller.enqueue(delta('{"nodes":['));
        controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const events = await readEvents(await worker.fetch(streamRequest(), env));
    const error = events.find(event => event.name === 'error').data;
    expect(error.code).toBe('provider_stream_interrupted');
    expect(error.error).not.toMatch(/could not be reached/);
    expect(error.attempts).toMatchObject([{ backend: 'anthropic', outcome: 'stream_interrupted', error_name: 'TypeError', error_cause: 'ECONNRESET' }]);
  });
});

describe('client abort and disconnect during a streamed reply', () => {
  it('records the in-flight attempt as cancelled when the request is aborted mid-reply', async () => {
    let providerController;
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        providerController = controller;
        controller.enqueue(sse({ type: 'message_start', message: { usage: { input_tokens: 900 } } }));
        controller.enqueue(delta('{"nodes":[{"id":"orchard"'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const aborter = new AbortController();
    const response = await worker.fetch(streamRequest(aborter.signal), env);
    const events = await readEvents(response, { after: 'token_progress', act: async () => aborter.abort() });
    expect(providerController).toBeDefined();
    const error = events.find(event => event.name === 'error').data;
    expect(error.code).toBe('cancelled');
    expect(error.attempts.map(attempt => attempt.outcome)).toEqual(['cancelled']);
    expect(error.attempts[0].stage).toBeUndefined();
  });

  it('cancels the provider read when the browser cancels the Worker stream', async () => {
    const cancelled = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: 'message_start', message: { usage: { input_tokens: 900 } } }));
        controller.enqueue(delta('{"nodes":['));
      },
      cancel: cancelled,
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const response = await worker.fetch(streamRequest(), env);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: token_progress')) seen += decoder.decode((await reader.read()).value, { stream: true });
    await reader.cancel();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled(), { timeout: 1000 });
  });
});

describe('provider stream bounds', () => {
  const openRouterStream = events => new Response(new ReadableStream({
    start(controller) { for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  // Envelope fields like these surround every token on real OpenAI-compatible streams.
  const envelope = text => ({ id: 'gen-synthetic-000000000000', object: 'chat.completion.chunk', created: 1_790_000_000,
    model: 'synthetic/model', provider: 'synthetic-provider', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null, logprobs: null }] });

  it('accepts a reply whose text fits even when its SSE envelope exceeds 2 MiB', async () => {
    const events = Array.from({ length: 12_000 }, () => envelope('ab'));
    const wire = events.reduce((sum, event) => sum + JSON.stringify(event).length + 8, 0);
    expect(wire).toBeGreaterThan(2 * 1024 * 1024);
    const completion = await readProviderStream(openRouterStream(events), { anthropic: false });
    expect(completion.choices[0].message.content).toHaveLength(24_000);
  });

  it('refuses a reply whose text exceeds 2 MiB', async () => {
    const big = 'x'.repeat(64 * 1024);
    const events = Array.from({ length: 33 }, () => envelope(big));
    await expect(readProviderStream(openRouterStream(events), { anthropic: false })).rejects.toMatchObject({ code: 'body_limit' });
  });

  it('rejects, rather than returning a partial reply, when its signal aborts mid-stream', async () => {
    const aborter = new AbortController();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope('{"nodes":['))}\n\n`)); },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const pending = readProviderStream(response, { anthropic: false, signal: aborter.signal, onFirstToken: () => queueMicrotask(() => aborter.abort()) });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// Pins the usage the Worker reports before and after usage parsing was consolidated (review finding 3).
describe('usage reported for an accepted reply', () => {
  const auditReply = JSON.stringify({ format: 'audit-v1', independent_points: [], contradictions: [], entity_splits: [] });
  const auditRequest = route => worker.fetch(new Request(SITE + '/api/cloud/map/generate', { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-map-consent': 'generate-v1' },
    body: JSON.stringify({ source, task: 'audit', nodes: [], routes: [route] }) }), env);

  it('reads Anthropic token counts and totals them', async () => {
    fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: auditReply }], usage: { input_tokens: 1200, output_tokens: 300 } }));
    const body = await (await auditRequest(routes[0])).json();
    expect(body.usage).toEqual({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 });
    expect(body.attempts).toMatchObject([{ outcome: 'accepted', input_tokens: 1200, output_tokens: 300, stop_reason: 'end_turn' }]);
  });

  it('reads OpenRouter token counts, total and cost', async () => {
    fetch.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: auditReply } }],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000, cost: 0.0042 } }));
    const body = await (await auditRequest({ backend: 'openrouter', key: 'sk-or-synthetic-personal-key-000000', model: 'synthetic/model' })).json();
    expect(body.usage).toEqual({ input_tokens: 800, output_tokens: 200, total_tokens: 1000, cost_usd: 0.0042 });
    expect(body.attempts).toMatchObject([{ outcome: 'accepted', input_tokens: 800, output_tokens: 200 }]);
  });

  it('omits usage when the provider reports none', async () => {
    fetch.mockResolvedValueOnce(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: auditReply }] }));
    const body = await (await auditRequest(routes[0])).json();
    expect(body.usage).toBeUndefined();
  });
});
