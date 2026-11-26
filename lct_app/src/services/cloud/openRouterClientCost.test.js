// @vitest-environment node
// Test intent (browser cost ledger for Sites generation; synthetic network and fixtures only):
// - every billed attempt counts toward a call's tokens: rejected and fallen-back attempts too, on success and on failure;
// - the accepted attempt is counted once, through the reply's usage;
// - a provider cost is complete only when it covers every billed attempt;
// - an aborted streamed generation is a cancellation, never a failed call in the ledger;
// - a streamed reply larger than the JSON reply bound is refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditRecordingMap, extractEpistemicMap, generateOrderedRecordingMap, verifyFactualClaim } from './openRouterClient.js';
import { createRecordingThreads } from './recordingThreads.js';
import { readSitesCostEntries, recordSitesCostEntry, summarizeSitesCosts } from './sitesCostStore.js';

const source = { recordingId: 'fixture-cost', startedAt: 1_790_000_000_000, complete: true,
  finalTokens: [{ text: 'Synthetic words.', speaker: 'fixture-speaker', startMs: 0, endMs: 1200 }] };
const graph = { nodes: [{ id: 'fixture-moment', node_name: 'Synthetic moment', semantic_level: 1, semantic_type: 'chunk',
  source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Synthetic words.' }], edges: [] };
const route = { backend: 'anthropic' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rejected = { backend: 'anthropic', task: 'map', outcome: 'rejected', stage: 'choice_finish', stop_reason: 'max_tokens',
  input_tokens: 1000, output_tokens: 8192 };
const accepted = { backend: 'anthropic', task: 'map', outcome: 'accepted', input_tokens: 1000, output_tokens: 400 };

function memoryStorage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key), clear: () => items.clear() };
}
beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cost ledger entries count every billed attempt', () => {
  it('adds rejected attempts to the accepted reply usage without counting the accepted attempt twice', () => {
    const entry = recordSitesCostEntry({ provider: 'anthropic', model: 'claude-fixture',
      usage: { input_tokens: 1000, output_tokens: 400, total_tokens: 1400 }, attempts: [rejected, accepted] });
    expect(entry).toMatchObject({ inputTokens: 2000, outputTokens: 8592, totalTokens: 10_592 });
  });

  it('counts attempt tokens when a failed call has no reply usage', () => {
    const entry = recordSitesCostEntry({ provider: 'anthropic', model: 'claude-fixture', outcome: 'error', attempts: [rejected] });
    expect(entry).toMatchObject({ inputTokens: 1000, outputTokens: 8192, totalTokens: 9192 });
  });

  it('marks a provider cost incomplete when an earlier billed attempt has no reported cost', () => {
    recordSitesCostEntry({ provider: 'openrouter', model: 'fixture/a', usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 } });
    recordSitesCostEntry({ provider: 'openrouter', model: 'fixture/a', usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.02 },
      attempts: [{ ...rejected, backend: 'openrouter' }, { ...accepted, backend: 'openrouter' }] });
    recordSitesCostEntry({ provider: 'anthropic', model: 'claude-fixture', usage: { input_tokens: 10, output_tokens: 5 } });
    const summary = summarizeSitesCosts(readSitesCostEntries(), 'all');
    expect(summary).toMatchObject({ calls: 3, costReportedCalls: 1, reportedCostUsd: 0.03 });
  });
});

describe('Sites generation calls record billed tokens on success and failure', () => {
  const failure = { code: 'invalid_completion', error: 'synthetic', stop_reason: 'max_tokens', attempts: [rejected] };

  it('records rejected-then-accepted map attempts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ request_id: '00000000-0000-4000-8000-000000000001', backend: 'anthropic',
      model: 'claude-fixture', artifact: createRecordingThreads({ ...source, graph }).bundle,
      usage: { input_tokens: 1000, output_tokens: 400, total_tokens: 1400 }, attempts: [rejected, accepted] })));
    await generateOrderedRecordingMap(source, new AbortController().signal, [route], undefined);
    expect(readSitesCostEntries()).toMatchObject([{ kind: 'map', outcome: 'ok', inputTokens: 2000, outputTokens: 8592 }]);
  });

  it('records the billed tokens of a failed map call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(failure, 502)));
    await expect(generateOrderedRecordingMap(source, new AbortController().signal, [route], undefined)).rejects.toMatchObject({ code: 'invalid_completion' });
    expect(readSitesCostEntries()).toMatchObject([{ kind: 'map', outcome: 'error', inputTokens: 1000, outputTokens: 8192 }]);
  });

  it.each([
    ['audit', signal => auditRecordingMap(source, signal, route, [])],
    ['epistemic', signal => extractEpistemicMap(source, signal, [route], [])],
    ['fact_check', signal => verifyFactualClaim('Synthetic claim.', signal, [route])],
  ])('records the billed tokens of a failed %s call', async (kind, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...failure, attempts: [{ ...rejected, task: kind }] }, 502)));
    await expect(call(new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_completion' });
    expect(readSitesCostEntries()).toMatchObject([{ kind, outcome: 'error', inputTokens: 1000, outputTokens: 8192 }]);
  });

  it('records the rejected attempt that preceded an accepted audit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ request_id: 'fixture-audit', task: 'audit', backend: 'anthropic', model: 'claude-fixture',
      findings: [], usage: { input_tokens: 1000, output_tokens: 400, total_tokens: 1400 }, attempts: [rejected, accepted] })));
    await auditRecordingMap(source, new AbortController().signal, route, []);
    expect(readSitesCostEntries()).toMatchObject([{ kind: 'audit', outcome: 'ok', inputTokens: 2000, outputTokens: 8592 }]);
  });
});

describe('streamed generation in the browser', () => {
  const sseResponse = (start) => new Response(new ReadableStream({ start }), { headers: { 'content-type': 'text/event-stream' } });
  const block = (event, data) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  it('rejects as aborted, and records no failed call, when the user cancels mid-stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(controller => controller.enqueue(block('stage', { stage: 'admitted' })))));
    const aborter = new AbortController();
    const pending = generateOrderedRecordingMap(source, aborter.signal, [route], undefined,
      { onEvent: () => queueMicrotask(() => aborter.abort()) });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readSitesCostEntries()).toEqual([]);
  });

  it('refuses a streamed event larger than the JSON reply bound', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 4096);
    const valid = { request_id: '00000000-0000-4000-8000-000000000001', backend: 'anthropic', model: 'claude-fixture',
      artifact: createRecordingThreads({ ...source, graph }).bundle };
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(controller => {
      controller.enqueue(block('complete', { ...valid, unused: huge })); controller.close();
    })));
    await expect(generateOrderedRecordingMap(source, new AbortController().signal, [route], undefined, { onEvent: () => {} }))
      .rejects.toThrow(/unreadable or oversized/);
  });

  it('names a dropped connection mid-stream instead of surfacing a bare network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(controller => {
      controller.enqueue(block('stage', { stage: 'admitted' })); controller.error(new TypeError('network error'));
    })));
    await expect(generateOrderedRecordingMap(source, new AbortController().signal, [route], undefined, { onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'stream_interrupted' });
  });
});
