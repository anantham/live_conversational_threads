// @vitest-environment jsdom
// Test intent:
// - An external claim check merges its result onto the map as it is when the check finishes, so an edit
//   made while it ran (here a reaction) is kept on screen and in the saved copy.
// - A claim check whose save fails says so in a visible alert, not only inside the closed options menu.
// The landscape canvas is replaced by buttons that call the viewer's own handlers; all content is synthetic.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';

const context = vi.hoisted(() => ({ bundle: null }));
const spies = vi.hoisted(() => ({ remember: null, verify: null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}),
  useLocation: () => ({ pathname: '/view', search: '', state: { threadsBundle: context.bundle, remember: true, sourceName: 'fixture.threads' } }) }));
vi.mock('../contexts/SitesRuntimeContext', () => ({ useSitesRuntime: () => ({
  preferences: { map: ['anthropic'], models: { anthropic: 'claude-test' } }, keys: { anthropic: 'synthetic-map-key' } }) }));
vi.mock('../services/cloud/openRouterClient.js', async importOriginal => ({
  ...(await importOriginal()), verifyFactualClaim: (...args) => spies.verify(...args) }));
vi.mock('../services/dataProvider', () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock('../hooks/useMediaQuery', () => ({ COMPACT_VIEWER_QUERY: 'fixture-compact', useMediaQuery: () => false }));
vi.mock('../services/threadsLibraryStore', () => ({ rememberThreadsArtifact: (...args) => spies.remember(...args),
  getThreadsLibraryRecord: () => null, getThreadsLibraryRecordByDriveFileId: () => null, listThreadsLibraryRecords: async () => [] }));
vi.mock('../services/cloud/qualityLedgerStore.js', () => ({ recordQualitySnapshot: () => {} }));
vi.mock('../components/threads/SpatialLandscapeCanvas', () => ({ default: ({ bundle, nodes, onAddReaction, onVerifyClaim, overflowMenu }) => (
  <div>
    {overflowMenu}
    <button type="button" onClick={() => onVerifyClaim('claim-1', 'The garden needs water.')}>stub verify</button>
    <button type="button" onClick={() => onAddReaction({ nodeId: nodes[0].id, kind: 'revisit' })}>stub react</button>
    <output aria-label="reactions">{(bundle.reaction_markers || []).length}</output>
    <output aria-label="evidence">{bundle.epistemic?.factual_claims?.[0]?.external_evidence?.status || 'none'}</output>
  </div>) }));
vi.mock('../components/MinimalGraph', () => ({ default: () => null }));
vi.mock('../components/MinimalLegend', () => ({ default: () => null }));
vi.mock('../components/NodeDetail', () => ({ default: () => null }));
vi.mock('../components/TimelineRibbon', () => ({ default: () => null }));
vi.mock('../components/threads/YouTubeSourcePanel', () => ({ default: () => null }));
import ThreadsViewer from './ThreadsViewer.jsx';

const source = { recordingId: 'fixture-claim-check', startedAt: 1_790_000_000_000, complete: true,
  finalTokens: [{ text: 'The garden needs water.', speaker: 'fixture-a', startMs: 1000, endMs: 2000 }] };
const graph = { nodes: [{ id: 'garden', node_name: 'Garden', semantic_type: 'chunk', semantic_level: 1,
  source_ref: { utterance_ids: ['utterance-0001'] } }], edges: [] };
const factCheck = { status: 'supported', note: 'Plants need water.', sources: [] };

let host, root;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  spies.remember = vi.fn(async () => ({ id: 'fixture-saved' }));
  spies.verify = vi.fn();
  context.bundle = { ...createRecordingThreads({ ...source, graph }).bundle,
    epistemic: { cruxes: [], normative_assumptions: [], factual_claims: [{ id: 'claim-1', node_id: 'garden', note: 'The garden needs water.' }] } };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network request is expected'); }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = label => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label).click());
const shown = label => host.querySelector(`[aria-label="${label}"]`).textContent;

it('keeps a reaction made while a claim check runs, on screen and in the saved copy', async () => {
  const check = deferred();
  spies.verify.mockImplementation(() => check.promise);
  await act(async () => root.render(<ThreadsViewer />));
  await click('stub verify');
  await click('stub react');
  expect(shown('reactions')).toBe('1');
  await act(async () => { check.resolve({ factCheck, backend: 'anthropic', model: 'claude-test' }); });
  expect(shown('evidence')).toBe('supported');
  expect(shown('reactions')).toBe('1');
  const saved = spies.remember.mock.calls.at(-1)[0];
  expect(saved.reaction_markers).toHaveLength(1);
  expect(saved.epistemic.factual_claims[0].external_evidence).toMatchObject({ status: 'supported', claim_sent: 'The garden needs water.' });
  expect(host.textContent).toContain('External claim check saved');
});

it('says so when a finished claim check cannot be saved', async () => {
  spies.verify.mockResolvedValue({ factCheck, backend: 'anthropic', model: 'claude-test' });
  await act(async () => root.render(<ThreadsViewer />));
  spies.remember.mockRejectedValueOnce(new Error('Synthetic storage failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await click('stub verify');
  await act(async () => { await Promise.resolve(); });
  expect(shown('evidence')).toBe('supported');
  expect(host.querySelector('[role="alert"]').textContent).toContain('The claim check is shown here but could not be saved.');
});
