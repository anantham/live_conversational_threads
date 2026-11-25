// @vitest-environment jsdom
// Test intent:
// - On an unsaved (generated, not remembered) map, boundary corrections, reactions and flags write nothing to
//   this device: no quality-ledger row (it holds the title) and no learned boundary preference.
// - On a map saved on this device, the same actions do record them.
// The landscape canvas is replaced by buttons that call the viewer's own handlers; all content is synthetic.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
import { stageGeneratedMap } from '../services/cloud/generatedMapHandoff.js';

const context = vi.hoisted(() => ({ bundle: null, generatedMapId: null, remember: false }));
const spies = vi.hoisted(() => ({ ledger: null, learned: null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ pathname: '/view', search: '', state: context.remember
  ? { threadsBundle: context.bundle, remember: true, sourceName: 'fixture-saved.threads' }
  : { generatedMapId: context.generatedMapId, remember: false } }) }));
vi.mock('../services/dataProvider', () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock('../hooks/useMediaQuery', () => ({ COMPACT_VIEWER_QUERY: 'fixture-compact', useMediaQuery: () => false }));
vi.mock('../services/threadsLibraryStore', () => ({ rememberThreadsArtifact: async () => ({ id: 'fixture-saved' }),
  getThreadsLibraryRecord: () => null, getThreadsLibraryRecordByDriveFileId: () => null, listThreadsLibraryRecords: async () => [] }));
vi.mock('../services/cloud/qualityLedgerStore.js', () => ({ recordQualitySnapshot: (...args) => spies.ledger(...args) }));
vi.mock('../services/cloud/boundaryLearningStore.js', async importOriginal => ({
  ...(await importOriginal()), recordBoundaryCorrection: (...args) => spies.learned(...args) }));
vi.mock('../components/threads/SpatialLandscapeCanvas', () => ({ default: ({ nodes, onBoundaryCorrection, onAddReaction, onFlagNode }) => (
  <div>
    <button type="button" onClick={() => onBoundaryCorrection({ kind: 'merge', sourceNodeId: nodes[1].id, targetNodeId: nodes[0].id })}>stub merge</button>
    <button type="button" onClick={() => onAddReaction({ nodeId: nodes[0].id, kind: 'revisit' })}>stub react</button>
    <button type="button" onClick={() => onFlagNode(nodes[0].id, 'irrelevant')}>stub flag</button>
  </div>) }));
vi.mock('../components/MinimalGraph', () => ({ default: () => null }));
vi.mock('../components/MinimalLegend', () => ({ default: () => null }));
vi.mock('../components/NodeDetail', () => ({ default: () => null }));
vi.mock('../components/TimelineRibbon', () => ({ default: () => null }));
vi.mock('../components/threads/YouTubeSourcePanel', () => ({ default: () => null }));
import ThreadsViewer from './ThreadsViewer.jsx';

const source = { recordingId: 'fixture-ledger', startedAt: 1_790_000_000_000, complete: true,
  finalTokens: [{ text: 'First synthetic turn.', speaker: 'fixture-a', startMs: 1000, endMs: 2000 },
    { text: 'Second synthetic turn.', speaker: 'fixture-b', startMs: 3000, endMs: 4000 }] };
const graph = { nodes: [
  { id: 'garden', node_name: 'Garden', semantic_type: 'chunk', semantic_level: 1, source_ref: { utterance_ids: ['utterance-0001'] } },
  { id: 'tools', node_name: 'Tools', semantic_type: 'chunk', semantic_level: 1, source_ref: { utterance_ids: ['utterance-0002'] } }], edges: [] };

let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  spies.ledger = vi.fn(); spies.learned = vi.fn();
  context.bundle = createRecordingThreads({ ...source, graph }).bundle;
  context.generatedMapId = stageGeneratedMap(context.bundle);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network request is expected'); }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = label => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label).click());

it('writes no quality row and no learned preference for an unsaved map', async () => {
  context.remember = false;
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain('not saved');
  await click('stub react');
  await click('stub flag');
  await click('stub merge');
  expect(spies.ledger).not.toHaveBeenCalled();
  expect(spies.learned).not.toHaveBeenCalled();
});

it('records quality rows and the learned preference for a map saved on this device', async () => {
  context.remember = true;
  await act(async () => root.render(<ThreadsViewer />));
  await click('stub react');
  await click('stub flag');
  await click('stub merge');
  expect(spies.ledger).toHaveBeenCalledTimes(3);
  expect(spies.learned).toHaveBeenCalledTimes(1);
});
