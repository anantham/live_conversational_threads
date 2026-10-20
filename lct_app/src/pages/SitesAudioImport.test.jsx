// Test Intent: tests/intent/cloud-audio-import.md. Public form -> transcript/map -> archive/export outcomes.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sessions: [], writes: [], restored: null, fail: false }));
vi.mock('../services/cloud/localConversationStore.js', () => ({
  readLocalConversation: async () => fixture.restored,
  saveLocalConversation: async (snapshot, chunks) => { fixture.writes.push({ snapshot, chunks }); return 'revision-' + fixture.writes.length; },
}));
vi.mock('../components/MinimalGraph.jsx', () => ({ default: ({ graphData }) => <div aria-label="Rendered graph">{graphData.map(node => <span key={node.id}>{node.node_name}</span>)}</div> }));
const transcript = { finalText: 'Gardens need water.', partialText: '', partialTokens: [],
  finalTokens: [{ text: 'Gardens need water.', speaker: '1', startMs: 0, endMs: 500 }] };
vi.mock('../services/cloud/AudioImportSession.js', () => ({ AudioImportSession: class {
  constructor(callbacks) { this.callbacks = callbacks; fixture.sessions.push(this); }
  async start({ file }) {
    this.callbacks.onStage({ stage: 'transcribing', message: 'Transcribing your audio.' });
    const mimeType = file.name.endsWith('m4a') ? 'audio/mp4' : file.name.endsWith('wav') ? 'audio/wav' : 'audio/mpeg';
    const blob = file.slice(0, file.size, mimeType);
    this.callbacks.onAudio({ blob, mimeType, complete: true, segments: [{ number: 1, blob, mimeType, complete: true }] });
    if (fixture.fail) { this.callbacks.onStage({ stage: 'error', message: 'Provider refused' }); throw new Error('Provider refused'); }
    this.callbacks.onTranscript(transcript); this.callbacks.onStage({ stage: 'stopped', message: 'Transcript ready.' });
    return transcript;
  }
  cancel() { this.cancelled = true; }
} }));
import SitesAudioImport from './SitesAudioImport.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
let root, container, posts, holdMap, finishMap;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mapped = source => createRecordingThreads({ ...source, graph: { metadata: { conversation_title: 'Garden plan' },
  nodes: [{ id: 'garden-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Garden watering',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Gardens need water.' }], edges: [] } }).bundle;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fixture.sessions = []; fixture.writes = []; fixture.restored = null; fixture.fail = false;
  posts = []; holdMap = false; finishMap = null; localStorage.clear();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:synthetic-import'; static revokeObjectURL() {} });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/cloud/soniox/status') return response({ enabled: true, max_session_seconds: 300 });
    const backend = url.includes('/gemini/') ? 'gemini' : 'openrouter';
    if (url.endsWith('/status')) return response({ backend, enabled: true, available: true, configured: true, schema_ready: true, audience: 'public', model: 'synthetic-model', provider: 'synthetic-provider' });
    if (url.endsWith('/generate')) {
      const source = JSON.parse(options.body).source; posts.push({ url, source });
      const result = response({ request_id: '00000000-0000-4000-8000-000000000001', artifact: mapped(source) });
      if (holdMap) return new Promise(resolve => { finishMap = () => resolve(result); });
      return result;
    }
    throw new Error('Unexpected network destination');
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const button = name => [...container.querySelectorAll('button')].find(value => (value.getAttribute('aria-label') || value.textContent) === name);
const click = async name => { await act(async () => button(name).click()); };
async function mount(path = '/import-audio') {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><SitesAudioImport /></MemoryRouter>));
}
async function choose(name = 'garden.mp3') {
  const file = new File(['original synthetic audio'], name);
  await act(async () => {
    const input = container.querySelector('#audio-import-file');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return file;
}
async function permit() { await act(async () => container.querySelector('form input[type=checkbox]').click()); }
async function flushArchive() { await act(async () => new Promise(resolve => setTimeout(resolve, 250))); }

describe('cloud audio import page', () => {
  it('does not send files before consent and saves original audio, exact source and one generated map locally', async () => {
    await mount(); const file = await choose();
    expect(button('Create transcript & threads').disabled).toBe(true);
    expect(fixture.sessions).toHaveLength(0); expect(posts).toHaveLength(0);
    await permit(); await click('Create transcript & threads'); await flushArchive();
    expect(posts).toHaveLength(1); expect(posts[0].url).toBe('/api/cloud/openrouter/generate');
    expect(posts[0].source.finalTokens).toEqual(transcript.finalTokens);
    const saved = fixture.writes.at(-1).snapshot;
    expect(saved.recording.retention).toBe('local'); expect(saved.recording.source).toBe('audio-import');
    expect(saved.transcript.finalText).toBe('Gardens need water.');
    expect(saved.map.full_transcript).toBe('Gardens need water.'); expect(saved.map.conversation_id).toBe(saved.id);
    const chunk = fixture.writes.flatMap(write => write.chunks)[0];
    expect(chunk.recordingId).toBe(saved.id); expect(chunk.blob.size).toBe(file.size); expect(chunk.mimeType).toBe('audio/mpeg');
    expect(container.textContent).toContain('Garden watering');
    await click('Files & export');
    expect(container.querySelector('a[download$=".mp3"]')).toBeTruthy();
    expect(container.querySelector('audio').getAttribute('src')).toBe('blob:synthetic-import');
    expect(container.textContent).not.toContain('Save audio privately');
    expect(fetch.mock.calls.filter(([url]) => /cloud\/files|public/.test(url))).toHaveLength(0);
  });
  it('honors Gemini selection and ephemeral mode without conversation writes', async () => {
    localStorage.setItem('lct.conversation_retention.v1', 'ephemeral');
    await mount(); await choose('garden.m4a');
    await permit();
    await act(async () => { const select = container.querySelector('#import-provider'); select.value = 'gemini'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('form input[type=checkbox]').checked).toBe(false);
    expect(button('Create transcript & threads').disabled).toBe(true);
    await permit(); await click('Create transcript & threads'); await flushArchive();
    expect(posts).toHaveLength(1); expect(posts[0].url).toBe('/api/cloud/gemini/generate'); expect(fixture.writes).toHaveLength(0);
    await click('Files & export'); expect(container.querySelector('a[download$=".m4a"]')).toBeTruthy();
  });
  it('preserves the original file on provider refusal and never requests a map or retries automatically', async () => {
    fixture.fail = true; await mount(); const file = await choose('garden.wav'); await permit(); await click('Create transcript & threads'); await flushArchive();
    expect(container.textContent).toContain('Provider refused'); expect(fixture.sessions).toHaveLength(1); expect(posts).toHaveLength(0);
    expect(fixture.writes.flatMap(write => write.chunks)[0].blob.size).toBe(file.size);
    await click('Files & export'); expect(container.querySelector('a[download$=".wav"]')).toBeTruthy();
    expect(container.querySelector('#recording-transcript-json')).toBeNull();
  });
  it('cancels map waiting and ignores a late completion while keeping the transcript and original file', async () => {
    holdMap = true; await mount(); await choose(); await permit(); await click('Create transcript & threads');
    expect(posts).toHaveLength(1); expect(button('Stop processing')).toBeTruthy();
    await click('Stop processing'); await flushArchive(); await act(async () => finishMap());
    expect(posts).toHaveLength(1); expect(container.textContent).toContain('Stopped waiting for threads.');
    expect(fixture.writes.at(-1).snapshot.transcript.finalText).toBe('Gardens need water.');
    expect(fixture.writes.at(-1).snapshot.map).toBeNull();
  });
  it('reopens local audio, transcript and map without any provider POST', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const recording = { id, startedAt: 1000, transcribe: true, retention: 'local', source: 'audio-import' };
    const blob = new Blob(['original synthetic audio'], { type: 'audio/mp4' });
    fixture.restored = { id, recording, stage: 'stopped', title: 'Garden plan', transcript, map: mapped({ recordingId: id, startedAt: 1000, finalTokens: transcript.finalTokens, complete: true }),
      updatedAt: 1000, segments: [{ number: 1, mimeType: 'audio/mp4', complete: true, bytes: blob.size }],
      audio: { blob, mimeType: 'audio/mp4', complete: true, segments: [{ number: 1, blob, mimeType: 'audio/mp4', complete: true }] } };
    await mount('/import-audio?local=' + id);
    expect(container.textContent).toContain('Opened from this device.'); expect(container.textContent).toContain('Garden watering');
    expect(fixture.sessions).toHaveLength(0); expect(posts).toHaveLength(0);
    await click('Files & export'); expect(container.querySelector('a[download$=".m4a"]')).toBeTruthy();
  });
});

// Intent: the asynchronous setup check must not erase a missing browser-local file explanation.
it('keeps a missing local import error visible after provider readiness finishes', async () => {
  await mount('/import-audio?local=00000000-0000-4000-8000-000000000003');
  expect(container.textContent).toContain('This import is not saved in this browser.');
  expect(fixture.sessions).toHaveLength(0); expect(posts).toHaveLength(0);
});

// Intent: reopening a completed transcript without a map must not promise pending generation.
it('accurately describes a restored transcript when no map was saved', async () => {
  const id='00000000-0000-4000-8000-000000000004';
  fixture.restored={id,recording:{id,startedAt:1000,retention:'local',source:'audio-import'},stage:'stopped',title:'Synthetic',transcript,map:null,segments:[],updatedAt:1000,audio:null};
  await mount('/import-audio?local='+id);
  expect(container.textContent).toContain('No thread map is saved');
  expect(container.textContent).not.toContain('Threads appear after your transcript is ready.');
  expect(posts).toHaveLength(0); expect(fixture.sessions).toHaveLength(0);
});
