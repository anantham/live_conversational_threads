import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pipeline } from '@huggingface/transformers';

// Test intent: exercise the worker's message boundary with synthetic model I/O.
// Measured aggregate bytes reach the UI without vendor paths or source text;
// successful ranking and model failure/retry preserve request identity.
// This does not prove actual model download, WASM initialization, or inference.
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } }, pipeline: vi.fn(),
}));

const documents = [
  { key: 'node:d1', id: 'd1', kind: 'node', nodeId: 'd1', text: 'Synthetic bicycle passage' },
  { key: 'node:d2', id: 'd2', kind: 'node', nodeId: 'd2', text: 'Synthetic garden passage' },
];
let messages;

beforeEach(async () => {
  vi.resetModules();
  pipeline.mockReset();
  messages = [];
  vi.stubGlobal('self', { postMessage: message => messages.push(message) });
  await import('./conversationSearch.worker.js');
});
afterEach(() => vi.unstubAllGlobals());

function start(requestId) { self.onmessage({ data: { requestId, query: 'bicycle', documents } }); }
const vectorize = async input => ({ tolist: () => Array.isArray(input) ? [[1, 0], [0, 1]] : [[1, 0]] });

it('reports measured aggregate loading and returns real ranking through worker messages', async () => {
  pipeline.mockImplementation(async (_task, _model, options) => {
    options.progress_callback({ status: 'progress_total', loaded: 1500000, total: 2000000, files: { 'public-model-file': {} } });
    options.progress_callback({ status: 'progress', loaded: 999999, file: 'public-model-file' });
    options.progress_callback({ status: 'progress_total', loaded: Number.NaN });
    return vectorize;
  });
  start(4);
  await vi.waitFor(() => expect(messages.find(message => message.type === 'results')).toBeDefined());
  const progress = messages.filter(message => message.stage === 'model' && 'loadedBytes' in message);
  expect(progress).toEqual([{ requestId: 4, type: 'progress', stage: 'model', loadedBytes: 1500000 }]);
  expect(messages.find(message => message.type === 'results')).toMatchObject({ requestId: 4, results: [{ id: 'd1', text: documents[0].text, score: 1 }, { id: 'd2', score: 0 }] });
  expect(JSON.stringify(progress)).not.toContain('public-model-file');
});

it('reports a failed load and allows a subsequent request to complete', async () => {
  pipeline.mockRejectedValueOnce(new Error('Synthetic model unavailable')).mockResolvedValueOnce(vectorize);
  start(1);
  await vi.waitFor(() => expect(messages.find(message => message.type === 'error')).toMatchObject({ requestId: 1, message: 'On-device search failed: Synthetic model unavailable' }));
  start(2);
  await vi.waitFor(() => expect(messages.find(message => message.type === 'results')).toMatchObject({ requestId: 2, results: [{ id: 'd1', score: 1 }, { id: 'd2', score: 0 }] }));
});
