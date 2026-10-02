import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the graph's real state, tier controls, and diagnostic calls. React Flow
// only supplies a DOM canvas and geometry that jsdom cannot measure.
vi.mock('reactflow', async () => {
  const React = await import('react');
  const viewport = { x: 0, y: 0, zoom: 1 };
  const flow = {
    getZoom: () => viewport.zoom,
    getViewport: () => viewport,
    getNodes: () => [],
    getNode: () => null,
    fitView: () => Promise.resolve(true),
    setViewport: () => Promise.resolve(true),
    setCenter: () => Promise.resolve(true),
  };
  return {
    default: ({ nodes }) => React.createElement('div', { 'data-testid': 'flow' },
      nodes.map(node => React.createElement('span', { key: node.id, 'data-node-id': node.id }, node.data?.title))),
    ReactFlowProvider: ({ children }) => children,
    useReactFlow: () => flow,
    applyNodeChanges: (_changes, nodes) => nodes,
  };
});

import MinimalGraph from './MinimalGraph';

const graphData = [{ id: 'fixture-idea', semantic_level: 2, semantic_type: 'idea', node_name: 'Synthetic graph idea' }];
let container;
let root;
let logs;

async function renderGraph(props = {}) {
  await act(async () => {
    root.render(<MinimalGraph graphData={graphData} semanticEdges={[]} setSelectedNode={() => {}} {...props} />);
  });
}

function graphLogs() {
  return logs.mock.calls.filter(call => call[0] === '[MG]');
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.__MG_DEBUG__ = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.__MG_DEBUG__;
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('MinimalGraph per-instance diagnostics', () => {
  it('preserves the default graph debug behavior and tier control', async () => {
    await renderGraph();
    expect(container.querySelector('[data-node-id="fixture-idea"]')?.textContent).toBe('Synthetic graph idea');
    expect(graphLogs().some(call => call[1] === 'normalizedChunk')).toBe(true);
    const tier = [...container.querySelectorAll('button')].find(button => button.textContent === 'ideas');
    expect(tier).toBeTruthy();
    await act(async () => tier.click());
    expect(graphLogs().some(call => call[1] === 'tier button click')).toBe(true);
  });

  it('keeps a private graph and its tier control usable without graph diagnostics', async () => {
    await renderGraph({ diagnosticsEnabled: false });
    expect(container.querySelector('[data-node-id="fixture-idea"]')?.textContent).toBe('Synthetic graph idea');
    const tier = [...container.querySelectorAll('button')].find(button => button.textContent === 'ideas');
    expect(tier).toBeTruthy();
    await act(async () => tier.click());
    expect(tier.getAttribute('aria-pressed')).toBe('false');
    expect(graphLogs()).toEqual([]);
  });
});
