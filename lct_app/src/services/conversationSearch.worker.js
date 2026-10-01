import { env, pipeline } from '@huggingface/transformers';
import { rankConversationVectors } from './conversationSearch';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
let extractor;
let documents;
let vectors;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { requestId, query } = data;
    const send = message => self.postMessage({ requestId, ...message });
    const timings = [];
    try {
      if (!extractor) {
        const started = performance.now();
        send({ type: 'progress', stage: 'model' });
        extractor = await pipeline('feature-extraction', MODEL, { revision: '751bff37182d3f1213fa05d7196b954e230abad9', device: 'wasm', dtype: 'q8' });
        timings.push({ stage: 'model', durationMs: performance.now() - started });
      }
      if (!vectors) {
        const started = performance.now();
        documents = data.documents;
        vectors = [];
        send({ type: 'progress', stage: 'index', completed: 0, total: documents.length });
        for (let offset = 0; offset < documents.length; offset += 8) {
          const batch = documents.slice(offset, offset + 8);
          const output = await extractor(batch.map(item => item.text), { pooling: 'mean', normalize: true });
          vectors.push(...output.tolist());
          send({ type: 'progress', stage: 'index', completed: vectors.length, total: documents.length });
        }
        timings.push({ stage: 'index', durationMs: performance.now() - started });
      }
      const started = performance.now();
      send({ type: 'progress', stage: 'query' });
      const output = await extractor(query, { pooling: 'mean', normalize: true });
      const results = rankConversationVectors(documents, vectors, output.tolist()[0]);
      timings.push({ stage: 'query', durationMs: performance.now() - started });
      send({ type: 'results', results, timings });
    } catch (error) {
      // No query, document, participant name, or embedding is logged externally.
      send({ type: 'error', message: `On-device search failed: ${error.message || String(error)}` });
    }
  });
};
