// Test Intent: tests/intent/cloud-audio-import.md. Public form -> transcript/map -> archive/export outcomes.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sessions: [], writes: [], restored: null, fail: false, signedIn: false, uploads: [], holdUpload: false, badReceipt: false }));
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
    this.callbacks.onTranscript(transcript);
    if (fixture.holdTranscript) await new Promise(resolve => { fixture.finishTranscript = resolve; });
    if (this.cancelled) throw new DOMException('Aborted', 'AbortError');
    const words = fixture.liveTranscript || transcript;
    this.callbacks.onTranscript(words); this.callbacks.onStage({ stage: 'stopped', message: 'Transcript ready.' });
    return words;
  }
  cancel() { this.cancelled = true; this.callbacks.onStage({ stage: 'cancelled', message: 'Import stopped.' }); }
} }));
import SitesAudioImport from './SitesAudioImport.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
let root, container, posts, holdMap, finishMap, finishUpload;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mapped = source => createRecordingThreads({ ...source, graph: { metadata: { conversation_title: 'Garden plan' },
  nodes: [{ id: 'garden-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Garden watering',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Gardens need water.' }], edges: [] } }).bundle;
function savedImport(bytes = 'original synthetic audio') {
  const id = '00000000-0000-4000-8000-000000000002';
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const recording = { id, startedAt: 1000, transcribe: true, retention: 'local', source: 'audio-import' };
  fixture.restored = { id, recording, title: 'Garden plan', stage: 'stopped', updatedAt: 1000, transcript,
    map: mapped({ recordingId: id, startedAt: 1000, finalTokens: transcript.finalTokens, complete: true }),
    segments: [{ number: 1, mimeType: 'audio/mpeg', complete: true, bytes: blob.size }],
    audio: { blob, mimeType: 'audio/mpeg', complete: true } };
  return '/import-audio?local=' + id;
}
const fileText = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(file);
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fixture.sessions = []; fixture.writes = []; fixture.restored = null; fixture.fail = false;
  fixture.signedIn = false; fixture.uploads = []; fixture.holdUpload = false; fixture.badReceipt = false;
  fixture.sessionHTML = false; fixture.storagePatch = {}; fixture.uploadStatus = 201;
  finishUpload = null; fixture.holdTranscript = false; fixture.liveTranscript = null; fixture.finishTranscript = null; fixture.mapFailure = false;
  posts = []; holdMap = false; finishMap = null; localStorage.clear();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:synthetic-import'; static revokeObjectURL() {} });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/cloud/soniox/status') return response({ enabled: true, max_session_seconds: 300 });
    if (url === '/api/auth/session') return fixture.sessionHTML ? new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }) : response(fixture.signedIn ? { authenticated: true, user: { id: 'synthetic-owner' } } : { authenticated: false }, fixture.signedIn ? 200 : 401);
    if (url === '/api/cloud/files/status') return response({ enabled: true, configured: true, synthetic_only: false, visibility: 'private', limits: { maxFileBytes: 2 * 1024 * 1024 }, ...fixture.storagePatch });
    if (url === '/api/cloud/files' && options?.method === 'POST') {
      fixture.uploads.push(options);
      if (fixture.uploadStatus !== 201) return response({ code: 'storage_capacity', error: 'Synthetic storage limit reached.' }, fixture.uploadStatus);
      const receipt = response({ file: { id: '00000000-0000-4000-8000-000000000099', state: 'ready', visibility: 'private',
        filename: decodeURIComponent(options.headers['X-LCT-Filename']), byte_size: options.body.size,
        content_type: options.headers['Content-Type'] } }, 201);
      if (fixture.holdUpload) return new Promise(resolve => { finishUpload = () => resolve(receipt); });
      return fixture.badReceipt ? response({ file: { state: 'staging' } }, 201) : receipt;
    }
    const backend = url.includes('/gemini/') ? 'gemini' : 'openrouter';
    if (url.endsWith('/status')) return response({ backend, enabled: true, available: true, configured: true, schema_ready: true, audience: 'public', model: 'synthetic-model', provider: 'synthetic-provider' });
    if (url.endsWith('/generate')) {
      const source = JSON.parse(options.body).source; posts.push({ url, source, signal: options.signal });
      if (fixture.mapFailure) return response({ code: 'provider_refused' }, 502);
      const result = response({ request_id: '00000000-0000-4000-8000-000000000001', artifact: mapped(source) });
      if (holdMap) return new Promise(resolve => { finishMap = () => resolve(result); });
      return result;
    }
    throw new Error('Unexpected network destination');
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
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
  it('lets a signed-in user explicitly save original audio, exact transcript and map without automatic cloud writes', async () => {
    fixture.signedIn = true;
    await mount(savedImport());
    expect(fixture.uploads).toHaveLength(0); expect(posts).toHaveLength(0); expect(fixture.sessions).toHaveLength(0);
    await click('Files & export');
    expect(button('Save audio privately')?.disabled).toBe(false);
    await click('Save audio privately');
    expect(container.textContent).toContain('Audio saved to your private cloud files.');
    expect(fixture.uploads).toHaveLength(1);
    expect(await fileText(fixture.uploads[0].body)).toBe('original synthetic audio');
    expect(fixture.uploads[0].headers['X-LCT-Storage-Write']).toBe('1');
    await click('Save transcript privately');
    const exported = JSON.parse(await fileText(fixture.uploads[1].body));
    expect(exported.recording_id).toBe(fixture.restored.id);
    expect(exported.full_transcript).toBe(transcript.finalText);
    await click('AI map'); await click('Save map privately');
    const map = JSON.parse(await fileText(fixture.uploads[2].body));
    expect(map.conversation_id).toBe(fixture.restored.id); expect(map.full_transcript).toBe(transcript.finalText);
    expect(map.graph_data[0].source_ref.utterance_ids).toEqual(['utterance-0001']);
    expect(fixture.restored.recording.retention).toBe('local');
    expect(posts).toHaveLength(0);
    expect(fetch.mock.calls.some(([url, options]) => url.includes('/public') && options?.method === 'POST')).toBe(false);
  });
  it('rechecks sign-in before sending a private copy and preserves downloads after expiry', async () => {
    fixture.signedIn = true; await mount(savedImport()); await click('Files & export');
    expect(button('Save audio privately')?.disabled).toBe(false);
    fixture.signedIn = false; await click('Save audio privately');
    expect(fixture.uploads).toHaveLength(0);
    expect(container.textContent).toContain('Sign in');
    expect(container.querySelector('a[download$=".mp3"]')).toBeTruthy();
  });
  it('refuses an over-limit private audio copy locally without changing the local archive', async () => {
    fixture.signedIn = true; await mount(savedImport(new Uint8Array(2 * 1024 * 1024 + 1))); await click('Files & export');
    await click('Save audio privately');
    expect(fixture.uploads).toHaveLength(0); expect(container.textContent).toContain('2.0 MiB');
    expect(fixture.restored.audio.blob.size).toBe(2 * 1024 * 1024 + 1);
  });
  it('does not claim an uncertain private receipt succeeded or retry it', async () => {
    fixture.signedIn = true; fixture.badReceipt = true; await mount(savedImport()); await click('Files & export');
    await click('Save audio privately');
    expect(fixture.uploads).toHaveLength(1);
    expect(container.textContent).toContain('Check Private files before retrying');
    expect(container.textContent).not.toContain('Audio saved to your private cloud files.');
  });
  it('cancels a private upload, ignores a late receipt, and retains the playable local source', async () => {
    fixture.signedIn = true; fixture.holdUpload = true; await mount(savedImport()); await click('Files & export');
    await click('Save audio privately'); expect(fixture.uploads).toHaveLength(1);
    expect(button('Save transcript privately').disabled).toBe(true);
    await click('Save transcript privately'); expect(fixture.uploads).toHaveLength(1);
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click('Cancel'); await act(async () => finishUpload());
    expect(fixture.uploads[0].signal.aborted).toBe(true);
    expect(container.textContent).not.toContain('Audio saved to your private cloud files.');
    expect(container.textContent).toContain('Check Private files before retrying');
    expect(container.querySelector('audio')).toBeTruthy(); expect(fixture.uploads).toHaveLength(1);
  });
  it('keeps an unreadable account unknown and enables private saving only after explicit successful recheck', async () => {
    fixture.signedIn = true; fixture.sessionHTML = true;
    await mount(savedImport()); await click('Files & export');
    expect(container.textContent).toContain('Private cloud saving is unavailable');
    expect(button('Save audio privately')).toBeUndefined();
    fixture.sessionHTML = false; await click('Check private saving');
    expect(button('Save audio privately')?.disabled).toBe(false);
    expect(fixture.uploads).toHaveLength(0); expect(posts).toHaveLength(0);
  });
  it.each([{ visibility: 'public' }, { synthetic_only: true }, { enabled: false }, { limits: { maxFileBytes: 0 } }])('does not offer private writes for unready or contradictory storage %j', async patch => {
    fixture.signedIn = true; fixture.storagePatch = patch;
    await mount(savedImport()); await click('Files & export');
    expect(button('Save audio privately')).toBeUndefined();
    expect(fixture.uploads).toHaveLength(0);
    expect(container.querySelector('a[download$=".mp3"]')).toBeTruthy();
  });
  it('preserves local files and displays a server quota refusal without retrying', async () => {
    fixture.signedIn = true; fixture.uploadStatus = 507;
    await mount(savedImport()); await click('Files & export'); await click('Save audio privately');
    expect(fixture.uploads).toHaveLength(1); expect(container.textContent).toContain('Synthetic storage limit reached');
    expect(container.textContent).not.toContain('Audio saved to your private cloud files.');
    expect(container.querySelector('audio')).toBeTruthy();
  });
  it('bounds a stalled private upload and never treats a late acknowledgement as success', async () => {
    vi.useFakeTimers(); fixture.signedIn = true; fixture.holdUpload = true;
    await mount(savedImport()); await click('Files & export'); await click('Save audio privately');
    await act(async () => vi.advanceTimersByTimeAsync(30001));
    expect(fixture.uploads[0].signal.aborted).toBe(true);
    expect(container.textContent).toContain('Check Private files before retrying');
    await act(async () => finishUpload());
    expect(container.textContent).not.toContain('Audio saved to your private cloud files.');
    expect(fixture.uploads).toHaveLength(1);
  });
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
    expect(fetch.mock.calls.filter(([url, options]) => /cloud\/files|public/.test(url) && options?.method === 'POST')).toHaveLength(0);
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


// Live intent: render real public map results while a streamed import remains unfinished;
// completion never duplicates or retries live attempts, cancellation ignores late output.
async function enableLive() {
  await click('AI map');
  await act(async () => [...container.querySelectorAll('label')].find(label => label.textContent.includes('I have permission to send these finalized words')).querySelector('input').click());
  await act(async () => container.querySelector('input[aria-label="Update map while I speak"]').click());
}
it('updates the visible map twice during input and does not add an implicit completion request', async () => {
  vi.useFakeTimers(); fixture.holdTranscript = true;
  await mount(); await choose(); await permit(); await click('Create transcript & threads');
  expect(posts).toHaveLength(0); expect(container.textContent).toContain('Transcribing your audio.');
  await enableLive(); await click('Generate conversation map');
  expect(posts).toHaveLength(1); expect(posts[0].source.complete).toBe(false);
  expect(container.querySelector('[aria-label="Rendered graph"]').textContent).toContain('Garden watering');
  const later = { ...transcript, finalTokens: [...transcript.finalTokens, { text: ' We should grow vegetables for the community and share the harvest. '.repeat(3), speaker: '2', startMs: 1000, endMs: 1500 }] };
  later.finalText = later.finalTokens.map(token => token.text).join('');
  await act(async () => fixture.sessions[0].callbacks.onTranscript(later)); fixture.liveTranscript = later;
  await act(async () => vi.advanceTimersByTimeAsync(45001));
  expect(posts).toHaveLength(2); expect(posts[1].source.complete).toBe(false);
  expect(posts[1].source.finalTokens).toEqual(later.finalTokens);
  expect(container.textContent).toContain('Transcribing your audio.');
  await act(async () => container.querySelector('input[aria-label="Update map while I speak"]').click());
  await act(async () => fixture.finishTranscript());
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(posts).toHaveLength(2);
  expect(fixture.writes.at(-1).snapshot.transcript.finalText).toBe(later.finalText);
  expect(fixture.writes.at(-1).snapshot.map.full_transcript).toBe(later.finalText);
  expect(fixture.uploads).toHaveLength(0);
});
it('does not retry a refused live request when the import finishes', async () => {
  fixture.holdTranscript = true; fixture.mapFailure = true;
  await mount(); await choose(); await permit(); await click('Create transcript & threads');
  await enableLive(); await click('Generate conversation map');
  expect(posts).toHaveLength(1); expect(container.textContent).toContain('provider refused');
  expect(container.querySelector('input[aria-label="Update map while I speak"]').checked).toBe(false);
  await act(async () => fixture.finishTranscript()); await flushArchive();
  expect(posts).toHaveLength(1); expect(fixture.writes.at(-1).snapshot.map).toBeNull();
  expect(fixture.writes.at(-1).snapshot.transcript.finalText).toBe(transcript.finalText);
});
it('stops the audio stream and map wait together, retaining confirmed words and ignoring late output', async () => {
  fixture.holdTranscript = true; holdMap = true;
  await mount(); await choose(); await permit(); await click('Create transcript & threads');
  await enableLive(); await click('Generate conversation map');
  expect(posts).toHaveLength(1);
  await click('Stop processing');
  expect(fixture.sessions[0].cancelled).toBe(true); expect(posts[0].signal.aborted).toBe(true);
  await act(async () => { finishMap(); fixture.finishTranscript(); }); await flushArchive();
  expect(fixture.writes.at(-1).snapshot.map).toBeNull(); expect(posts).toHaveLength(1);
  expect(fixture.writes.at(-1).snapshot.transcript.finalText).toBe(transcript.finalText);
  expect(fixture.writes.flatMap(write => write.chunks)[0].blob.size).toBeGreaterThan(0);
});
