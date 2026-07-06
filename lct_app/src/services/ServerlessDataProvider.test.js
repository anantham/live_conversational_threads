import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the serverless pipeline deps so we can assert ServerlessDataProvider
// consumes generateFullGraph's {nodes, metadata} contract correctly. A prior
// version read .newNodes / .conversation_title (undefined here — that's
// consolidateHierarchy's shape), silently dropping the consolidation tiers
// (themes/arcs) and the title. This pins the fix (grok review, 2026-07-06).

// vi.mock is hoisted above module-scope consts, so the shared fixtures + spies
// must come from vi.hoisted to be in scope inside the mock factories.
const H = vi.hoisted(() => {
  const EXTRACTED = [{ id: 'chunk-1', semantic_level: 1, node_name: 'chunk' }];
  const FULL_NODES = [...EXTRACTED, { id: 'theme-1', semantic_level: 3, node_name: 'theme' }];
  return {
    EXTRACTED,
    FULL_NODES,
    saveConversation: vi.fn().mockResolvedValue(undefined),
    saveGraph: vi.fn().mockResolvedValue(undefined),
  };
});
const { FULL_NODES, saveConversation, saveGraph } = H;

vi.mock('./serverless/sttClient', () => ({
  transcribeAudio: vi.fn().mockResolvedValue({ text: 'hello world', duration: 12 }),
}));
vi.mock('./serverless/graphGenerator', () => ({
  processTranscriptSegment: vi.fn().mockResolvedValue(H.EXTRACTED),
  generateFullGraph: vi.fn().mockResolvedValue({
    nodes: H.FULL_NODES,
    metadata: { conversation_title: 'Billing Rewrite', executive_summary: 'Chose strangler fig.' },
  }),
}));
vi.mock('./serverless/indexedDb', () => ({
  saveConversation: (...a) => H.saveConversation(...a),
  saveGraph: (...a) => H.saveGraph(...a),
  getConversation: vi.fn(),
  getGraph: vi.fn(),
  listConversations: vi.fn(),
}));

import { ServerlessDataProvider } from './ServerlessDataProvider';

async function drain(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe('ServerlessDataProvider.import.processFile graph contract', () => {
  afterEach(() => vi.clearAllMocks());

  it('saves the FULL node set (extraction + consolidation) and the title from metadata', async () => {
    const provider = new ServerlessDataProvider('sk-user');
    const fd = new FormData();
    fd.append('file', new File(['x'], 'clip.wav', { type: 'audio/wav' }));

    const res = await provider.import.processFile(fd);
    const stream = await drain(res);

    // saveGraph receives the full node set — NOT just the extracted nodes.
    expect(saveGraph).toHaveBeenCalledTimes(1);
    const savedNodes = saveGraph.mock.calls[0][1];
    expect(savedNodes.map((n) => n.id)).toEqual(['chunk-1', 'theme-1']);

    // Title + summary come off metadata (the old .conversation_title was undefined).
    expect(saveConversation).toHaveBeenCalledTimes(1);
    expect(saveConversation.mock.calls[0][0].title).toBe('Billing Rewrite');
    expect(saveConversation.mock.calls[0][0].executive_summary).toBe('Chose strangler fig.');

    // The emitted SSE stream carries the graph + a done event with the count.
    expect(stream).toContain('event: graph');
    expect(stream).toContain('event: done');
    expect(stream).toContain('"node_count":2');
  });
});
