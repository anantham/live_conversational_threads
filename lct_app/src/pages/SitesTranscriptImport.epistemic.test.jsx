// Test intent:
// - The background epistemic pass of an earlier run is cancelled when a newer run starts, and its late
//   result never replaces the newer map.
// - Leaving the page cancels a pending epistemic pass.
// - The epistemic pass and the map audit each merge only their own field onto the latest map, so
//   whichever finishes second keeps what the first one added.
// - The consent copy names the extra whole-transcript send when detail runs, and consent is asked again
//   when the detail choice changes what will be sent.
// - A run that stops early keeps its partial map for saving, but does not offer it for publishing.
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
const audit = { props: null };
vi.mock('../components/audit/MapAuditPanel.jsx', () => ({ default: props => { audit.props = props; return null; } }));
vi.mock('../components/publish/PublishLinkPanel.jsx', () => ({ default: () => <p>publish-panel</p> }));
vi.mock('../services/cloud/pdfTranscriptReader.js', () => ({ readTranscriptFile: vi.fn() }));

const runtime = { preferences: { guidance: '' } };
const routes = [{ backend: 'anthropic', model: 'claude-synthetic' }];
const parsed = { title: 'Garden plan', source: { recordingId: 'synthetic' }, turns: [{ text: 'One.' }, { text: 'Two.' }],
  wordCount: 2, speakers: ['Sam'], invitedEmails: [], mediaRefs: [], durationMs: 2000 };
const { MultiWindowPipelinePanel } = await import('./SitesTranscriptImport.jsx');

let host, root;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));
// runEpistemicAnalysis returns the lenses both on their own and inside the bundle.
const none = { cruxes: [], factual_claims: [], normative_assumptions: [] };
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

  await act(async () => { passes[0].resolve({ bundle: { id: 'map-1', epistemic: none }, epistemic: none }); });
  await flush();
  expect(onBundleReady).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'map-1', epistemic: none }));
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-2' });

  await act(async () => { passes[1].resolve({ bundle: { id: 'map-2', epistemic: none }, epistemic: none }); });
  await flush();
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-2', epistemic: none });
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

const lenses = { cruxes: [{ id: 'c1' }], factual_claims: [], normative_assumptions: [] };
const signal = { id: 's1', source: 'audit', kind: 'missed' };

it('keeps audit signals when the epistemic pass lands after an audit', async () => {
  const onBundleReady = vi.fn();
  const pass = deferred();
  pipeline.mockResolvedValueOnce({ bundle: { id: 'map-1' } });
  epistemic.mockImplementationOnce(() => pass.promise);
  await render(onBundleReady);
  await act(async () => { button('Build map').click(); });
  await flush();
  // The audit ran against the map without lenses and finished first.
  await act(async () => { audit.props.onBundleChange({ id: 'map-1', audit_signals: [signal] }); });
  await act(async () => { pass.resolve({ bundle: { id: 'map-1', epistemic: lenses }, epistemic: lenses }); });
  await flush();
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-1', audit_signals: [signal], epistemic: lenses });
});

it('keeps the lenses when an audit that started before them finishes after them', async () => {
  const onBundleReady = vi.fn();
  pipeline.mockResolvedValueOnce({ bundle: { id: 'map-1' } });
  epistemic.mockResolvedValueOnce({ bundle: { id: 'map-1', epistemic: lenses }, epistemic: lenses });
  await render(onBundleReady);
  await act(async () => { button('Build map').click(); });
  await flush();
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-1', epistemic: lenses });
  // runMapAudit returns the map it started from (no lenses) plus its signals.
  await act(async () => { audit.props.onBundleChange({ id: 'map-1', audit_signals: [signal] }); });
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'map-1', epistemic: lenses, audit_signals: [signal] });
});

it('asks for consent again when the detail choice changes what is sent', async () => {
  await render(vi.fn());
  const box = () => host.querySelector('label input[type="checkbox"]');
  expect(box().checked).toBe(true);
  const select = host.querySelector('select');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'none');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(box().checked).toBe(false);
  expect(host.textContent).not.toMatch(/once more with the finished map/);
});

it('does not offer a partial map from a stopped run for publishing', async () => {
  pipeline.mockImplementationOnce(async ({ onProgress }) => {
    onProgress({ phase: 'skeleton', partialBundle: { id: 'partial' } });
    throw new Error('Detail stopped.');
  }).mockResolvedValueOnce({ bundle: { id: 'whole' } });
  epistemic.mockImplementation(() => new Promise(() => {}));
  const onBundleReady = vi.fn();
  await render(onBundleReady);
  await act(async () => { button('Build map').click(); });
  await flush();
  expect(onBundleReady).toHaveBeenLastCalledWith({ id: 'partial' });
  expect(host.textContent).toMatch(/Detail stopped/);
  expect(host.textContent).not.toMatch(/publish-panel/);

  await act(async () => { button('Regenerate map').click(); });
  await flush();
  expect(host.textContent).toMatch(/publish-panel/);
});
