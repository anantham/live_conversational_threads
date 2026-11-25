// Test intent:
// - The background epistemic pass of an earlier run is cancelled when a newer run starts, and its late
//   result never replaces the newer map.
// - Leaving the page cancels a pending epistemic pass.
// - The consent copy names the extra whole-transcript send when detail runs.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pipeline = vi.fn();
const epistemic = vi.fn();
vi.mock('../contexts/SitesRuntimeContext', () => ({ useSitesRuntime: () => runtime }));
vi.mock('../services/cloud/openRouterClient.js', () => ({
  configuredMapRoutes: () => routes,
  getOrderedMapStatus: async () => ({ enabled: true, available: true }),
  MAP_PROVIDERS: { anthropic: { name: 'Claude', recipient: 'Anthropic' } },
}));
vi.mock('../services/cloud/glanceDetailPipeline.js', () => ({ runGlanceDetailPipeline: (...args) => pipeline(...args) }));
vi.mock('../services/cloud/epistemicPipeline.js', () => ({ runEpistemicAnalysis: (...args) => epistemic(...args) }));
vi.mock('../components/recording/RecordingConversationMap.jsx', () => ({ default: () => null }));
vi.mock('../components/recording/LiveConversationGraph.jsx', () => ({ default: () => null }));
vi.mock('../components/audit/MapAuditPanel.jsx', () => ({ default: () => null }));
vi.mock('../components/publish/PublishLinkPanel.jsx', () => ({ default: () => null }));
vi.mock('../services/cloud/pdfTranscriptReader.js', () => ({ readTranscriptFile: vi.fn() }));

const runtime = { preferences: { guidance: '' } };
const routes = [{ backend: 'anthropic', model: 'claude-synthetic' }];
const parsed = { title: 'Garden plan', source: { recordingId: 'synthetic' }, turns: [{ text: 'One.' }, { text: 'Two.' }],
  wordCount: 2, speakers: ['Sam'], invitedEmails: [], mediaRefs: [], durationMs: 2000 };
const { MultiWindowPipelinePanel } = await import('./SitesTranscriptImport.jsx');

let host, root;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  pipeline.mockReset();
  epistemic.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render(onBundleReady) {
  await act(async () => root.render(<MemoryRouter><MultiWindowPipelinePanel parsed={parsed} onBundleReady={onBundleReady} /></MemoryRouter>));
  await flush();
  act(() => host.querySelector('label input[type="checkbox"]').click());
}

it('cancels an earlier run\'s epistemic pass and never lets its late result replace the newer map', async () => {
  const onBundleReady = vi.fn();
  const passes = [deferred(), deferred()];
  pipeline.mockResolvedValueOnce({ bundle: { id: 'map-1' } }).mockResolvedValueOnce({ bundle: { id: 'map-2' } });
  epistemic.mockImplementationOnce(() => passes[0].promise).mockImplementationOnce(() => passes[1].promise);
  await render(onBundleReady);
  expect(host.textContent).toMatch(/whole transcript once more with the finished map/);

  await act(async () => { button('Build map').click(); });
  await flush();
  const firstSignal = epistemic.mock.calls[0][0].signal;
  await act(async () => { button('Regenerate map').click(); });
  await flush();
  expect(firstSignal.aborted).toBe(true);

  await act(async () => { passes[0].resolve({ bundle: { id: 'map-1', epistemic: {} }, epistemic: { cruxes: [], factual_claims: [], normative_assumptions: [] } }); });
  await flush();
  expect(onBundleReady).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'map-1', epistemic: {} }));
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-2' });

  await act(async () => { passes[1].resolve({ bundle: { id: 'map-2', epistemic: {} }, epistemic: { cruxes: [], factual_claims: [], normative_assumptions: [] } }); });
  await flush();
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-2', epistemic: {} });
});

it('cancels a pending epistemic pass when the page is left', async () => {
  pipeline.mockResolvedValueOnce({ bundle: { id: 'map-1' } });
  epistemic.mockImplementationOnce(() => new Promise(() => {}));
  await render(vi.fn());
  await act(async () => { button('Build map').click(); });
  await flush();
  const { signal } = epistemic.mock.calls[0][0];
  act(() => root.unmount());
  expect(signal.aborted).toBe(true);
  root = createRoot(host);
});
