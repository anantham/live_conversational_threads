// @vitest-environment node
// Intent: tests/intent/sites-recording-map.md; actual source/graph adapters and synthetic intercepted network only.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateRecordingMap, getRecordingMapStatus } from './openRouterClient.js';
import { createRecordingThreads } from './recordingThreads.js';
import { readThreadsFile } from '../threadsArtifact.js';

const source = { recordingId: 'fixture-map', startedAt: 1_790_000_000_000, complete: true,
  finalTokens: [{ text: 'Synthetic words.', speaker: 'fixture-speaker', startMs: 0, endMs: 1200 }] };
const graph = { nodes: [{ id: 'fixture-moment', node_name: 'Synthetic moment', semantic_level: 1, semantic_type: 'chunk',
  source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Synthetic words.' }], edges: [] };
const payload = () => ({ request_id: '00000000-0000-4000-8000-000000000001', artifact: createRecordingThreads({ ...source, graph }).bundle });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => response(payload()))));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sends fixed same-origin consented source and returns an actual readable portable file with source-owned provenance', async () => {
  const result = await generateRecordingMap(source, new AbortController().signal);
  expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.lastCall[0]).toBe('/api/cloud/openrouter/generate');
  expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({ source });
  expect(fetch.mock.lastCall[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-LCT-OpenRouter-Consent': 'generate-v1' } });
  expect(await readThreadsFile(result.file)).toEqual(payload().artifact);
});
it('refuses invalid source before network and checks actual readiness fields', async () => {
  await expect(generateRecordingMap({ ...source, finalTokens: [] })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(response({ enabled: true })); await expect(getRecordingMapStatus()).rejects.toThrow('unreadable');
  fetch.mockResolvedValueOnce(response({ enabled: false, available: false, configured: false, schema_ready: false, audience: null, model: null, provider: null }));
  expect(await getRecordingMapStatus()).toMatchObject({ enabled: false, available: false });
});
it.each(['identity', 'text', 'time', 'evidence', 'version', 'edge-schema', 'request-id'])('rejects response %s contradictions without producing a portable file', async mode => {
  const value = payload();
  if (mode === 'identity') value.artifact.conversation_id = 'fixture-other';
  if (mode === 'text') value.artifact.full_transcript = 'Wrong synthetic words';
  if (mode === 'time') value.artifact.utterances[0].timestamp_start = 900;
  if (mode === 'evidence') value.artifact.graph_data[0].source_ref.utterance_ids = ['fixture-other'];
  if (mode === 'version') value.artifact.format_version = 1;
  if (mode === 'edge-schema') value.artifact.edge_schema.endpoint_space = 'wrong';
  if (mode === 'request-id') value.request_id = 'wrong';
  fetch.mockResolvedValueOnce(response(value)); await expect(generateRecordingMap(source)).rejects.toThrow('unreadable');
});
it.each([401, 429, 503, 502])('sanitizes HTTP %s bodies and refuses incomplete results', async status => {
  fetch.mockResolvedValueOnce(response({ error: 'fixture sensitive provider detail' }, status));
  const error = await generateRecordingMap(source).catch(value => value);
  expect(error).toBeInstanceOf(Error); expect(error.status).toBe(status); expect(error.message).not.toContain('sensitive');
});
it('bounds declared and actual streamed responses and cancels the oversized reader', async () => {
  const cancelled = vi.fn();
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1025)); }, cancel: cancelled }),
    { headers: { 'content-type': 'application/json' } }));
  await expect(generateRecordingMap(source)).rejects.toThrow('oversized'); expect(cancelled).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '10000' } }));
  await expect(getRecordingMapStatus()).rejects.toThrow('oversized');
});
it('releases a stalled response reader on abort and cancels an already-aborted late response', async () => {
  for (const late of [false, true]) {
    const controller = new AbortController(), cancelled = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }));
    if (late) controller.abort();
    const pending = generateRecordingMap(source, controller.signal);
    await Promise.resolve(); await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled).toHaveBeenCalledTimes(1);
  }
});
