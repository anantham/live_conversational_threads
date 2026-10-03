// @vitest-environment jsdom
// Intent: tests/intent/sites-recording-map.md; exact synthetic recording output, no personal history.
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
import { stageGeneratedMap, readGeneratedMap } from '../services/cloud/generatedMapHandoff.js';
import { buildSpeakerColorMapForNodes, buildSpeakerOwnershipMapForNodes, resolveNodeColors } from '../components/graph/colorModes.js';

const context = vi.hoisted(() => ({ bundle: null, generatedMapId: null, compact: false, remember: false, local: { id: 'fixture-existing', title: 'Existing fixture' } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ pathname: '/view', search: '', state: context.remember
  ? { threadsBundle: context.bundle, remember: true, sourceName: 'fixture-generated.threads' }
  : { generatedMapId: context.generatedMapId, remember: false } }) }));
vi.mock('../services/dataProvider', () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock('../hooks/useMediaQuery', () => ({ COMPACT_VIEWER_QUERY: 'fixture-compact', useMediaQuery: () => context.compact }));
vi.mock('../services/threadsLibraryStore', () => ({ rememberThreadsArtifact: async bundle => { context.local = bundle; return { id: 'fixture-generated' }; },
  getThreadsLibraryRecord: () => { throw new Error('No stored source should be read'); }, getThreadsLibraryRecordByDriveFileId: () => { throw new Error('No Drive source should be read'); } }));
vi.mock('../components/MinimalGraph', () => ({ default: ({ graphData, diagnosticsEnabled }) => {
  const palette = buildSpeakerColorMapForNodes(graphData), ownership = buildSpeakerOwnershipMapForNodes(graphData);
  return <div data-testid="graph" data-diagnostics={String(diagnosticsEnabled)}>{graphData.map(node => <span key={node.id}
    data-node-id={node.id} style={{ background: resolveNodeColors({ mode: 'speaker', node,
      speakerColorMap: palette, speakerOwnershipMap: ownership }).fill }}>{node.node_name}</span>)}</div>;
} }));
vi.mock('../components/MinimalLegend', () => ({ default: ({ speakerColorMap }) => <div data-testid="legend">{Object.entries(speakerColorMap).map(([id, color]) => <span key={id} data-speaker-id={id} style={{ backgroundColor: color }}>{id}</span>)}</div> }));
vi.mock('../components/NodeDetail', () => ({ default: () => null }));
vi.mock('../components/TimelineRibbon', () => ({ default: () => null }));
vi.mock('../components/threads/YouTubeSourcePanel', () => ({ default: () => null }));
import ThreadsViewer from './ThreadsViewer.jsx';

const source = { recordingId: 'fixture-generated', startedAt: 1_790_000_000_000, complete: true,
  finalTokens: [{ text: 'Exact synthetic recorded words.', speaker: 'fixture-speaker', startMs: 1000, endMs: 2000 }] };
const graph = { nodes: [{ id: 'fixture-moment', node_name: 'Synthetic generated moment', semantic_type: 'chunk', semantic_level: 1,
  source_ref: { utterance_ids: ['utterance-0001'] } }], edges: [] };
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = true; window.history.replaceState(null, '', '/view'); localStorage.clear();
  context.bundle = createRecordingThreads({ ...source, graph }).bundle; context.local = { id: 'fixture-existing', title: 'Existing fixture' }; context.remember = false;
  context.generatedMapId = stageGeneratedMap(context.bundle);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No generated viewer network request is allowed'); }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.__MG_DEBUG__ = false; });
const click = label => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label).click());

it.each([false, true])('opens the actual generated source in Graph/Discussion without remembering or saving speaker edits (compact=%s)', async compact => {
  context.compact = compact;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await act(async () => root.render(<StrictMode><ThreadsViewer /></StrictMode>));
  expect(host.textContent).toContain('Synthetic generated moment');
  expect(host.textContent).toContain('Generated map · kept in this view · not saved');
  expect(host.querySelector('[data-testid="graph"]').dataset.diagnostics).toBe('false');
  const graphColor = host.querySelector('[data-node-id="fixture-moment"]').style.background;
  expect(graphColor).toBe(host.querySelector('[data-testid="legend"] [data-speaker-id="fixture-speaker"]').style.backgroundColor);
  await click('Discussion');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Synthetic generated moment')).click());
  expect(host.querySelector('[data-utterance-id="utterance-0001"]').textContent).toContain('Exact synthetic recorded words.');
  expect(host.querySelector('[data-utterance-id="utterance-0001"] > span[aria-hidden="true"]').style.backgroundColor).toBe(graphColor);
  expect(host.querySelector('button[aria-label^="Copy link"]')).toBeNull();
  expect(host.textContent).toContain('Names change in this view only');
  const input = host.querySelector('form input');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reviewed fixture speaker'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain('Reviewed fixture speaker');
  expect(context.local).toEqual({ id: 'fixture-existing', title: 'Existing fixture' });
  expect(context.bundle.utterances[0].speaker_display).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  expect(readGeneratedMap(context.generatedMapId)).toBeNull();
});
it('refuses an expired handoff without recovering the transcript from storage or making a request', async () => {
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain('Synthetic generated moment');
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain('This generated map is no longer available');
  expect(host.textContent).not.toContain('Exact synthetic recorded words.');
  expect(fetch).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  expect(context.local).toEqual({ id: 'fixture-existing', title: 'Existing fixture' });
});
it('downloads the current portable graph only on explicit action and retains ordinary imported-file remembering', async () => {
  context.compact = false;
  const create = vi.fn(() => 'blob:fixture-map'), revoke = vi.fn(); let downloaded;
  const NativeURL = globalThis.URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = create; static revokeObjectURL = revoke; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded = { name: this.download, href: this.href }; });
  await act(async () => root.render(<ThreadsViewer />)); expect(create).not.toHaveBeenCalled();
  await click('Download map');
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsText(create.mock.lastCall[0]);
  });
  expect(JSON.parse(text)).toEqual(context.bundle);
  expect(downloaded).toEqual({ name: 'recording-fixture-generated.threads', href: 'blob:fixture-map' }); expect(revoke).toHaveBeenCalledWith('blob:fixture-map');
  expect(context.local).toEqual({ id: 'fixture-existing', title: 'Existing fixture' });
  await act(async () => root.unmount()); root = createRoot(host); context.remember = true;
  await act(async () => root.render(<ThreadsViewer />));
  expect(context.local).toEqual(context.bundle); expect(host.textContent).toContain('Saved on this device');
});
