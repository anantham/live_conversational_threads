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
    if (fixture.holdDecode) {
      this.callbacks.onStage({ stage: 'preparing', message: 'Opening audio.' });
      await new Promise(resolve => { fixture.finishDecode = resolve; });
      if (this.cancelled) throw new DOMException('Aborted', 'AbortError');
    }
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
  cancel() { this.cancelled = true; this.callbacks.onStage({ stage: 'cancelled', message: 'Import stopped.' }); fixture.finishDecode?.(); }
} }));
import { SitesRuntimeContext } from '../contexts/SitesRuntimeContext';
import SitesAudioImport from './SitesAudioImport.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
import { DEFAULT_M5_TAILNET_URL } from '../services/cloud/m5TailnetFileSession.js';
import { SPEECH_PROVIDERS } from '../services/cloud/sitesProviderPreferences.js';
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
  fixture.holdDecode = false; fixture.finishDecode = null; fixture.sessionHTML = false; fixture.storagePatch = {}; fixture.uploadStatus = 201;
  finishUpload = null; fixture.holdTranscript = false; fixture.liveTranscript = null; fixture.finishTranscript = null; fixture.mapFailure = false;
  fixture.m5Urls = [];
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
    if (String(url).includes('.ts.net')) { fixture.m5Urls.push(String(url)); return response({ error: 'busy' }, 503); }
    const backend = url.split('/')[3];
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
async function mount(path = '/import-audio', runtime = null) {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><SitesRuntimeContext.Provider value={runtime}>
    <SitesAudioImport />
  </SitesRuntimeContext.Provider></MemoryRouter>));
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
  it('recovers from stalled transcription setup and ignores a late first response', async () => {
    vi.useFakeTimers();
    let resolveStatus;
    const first = new Promise(resolve => { resolveStatus = resolve; });
    const normal = fetch.getMockImplementation();
    let checks = 0;
    fetch.mockImplementation((path, options) => path === '/api/cloud/soniox/status' && ++checks === 1
      ? first : normal(path, options));
    await mount();
    expect(container.textContent).toContain('Checking transcription setup');
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    await click('Check setup again');
    await choose(); await permit();
    expect(container.querySelector('button[type=submit]').disabled).toBe(false);
    await act(async () => resolveStatus(response({ enabled: false, max_session_seconds: 300 })));
    expect(container.querySelector('button[type=submit]').disabled).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it('protects an active import and allows departure after an empty cancellation', async () => {
    fixture.holdDecode = true;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mount(); await choose(); await permit();
    await act(async () => container.querySelector('button[type=submit]').click());
    const activeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(activeUnload);
    expect(activeUnload.defaultPrevented).toBe(true);
    await click('Stop processing');
    const settledUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    await act(async () => container.querySelector('[aria-label="Back to home"]').click());
    expect(confirm).not.toHaveBeenCalled();
  });

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
  it.each([['gemini', 'Google Gemini through Google AI Studio'], ['anthropic', 'Anthropic (Claude)']])('honors %s selection and ephemeral mode without conversation writes', async (backend, recipient) => {
    localStorage.setItem('lct.conversation_retention.v1', 'ephemeral');
    await mount(); await choose('garden.m4a');
    await permit();
    await act(async () => { const select = container.querySelector('#import-provider'); select.value = backend; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('form input[type=checkbox]').checked).toBe(false);
    expect(container.textContent).toContain('Soniox for transcription and its transcript to ' + recipient);
    expect(button('Create transcript & threads').disabled).toBe(true);
    await permit(); await click('Create transcript & threads'); await flushArchive();
    expect(posts).toHaveLength(1); expect(posts[0].url).toBe(`/api/cloud/${backend}/generate`); expect(fixture.writes).toHaveLength(0);
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
  expect(container.querySelector('[aria-label="AI map · Needs attention"]')).toBeTruthy();
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


it('keeps a late partial map honest after the transcript completes, without replacing the full transcript', async () => {
  fixture.holdTranscript = true; holdMap = true;
  await mount(); await choose(); await permit(); await click('Create transcript & threads');
  await enableLive(); await click('Generate conversation map');
  fixture.liveTranscript = { ...transcript, finalText: transcript.finalText + ' More confirmed words.',
    finalTokens: [...transcript.finalTokens, { text: ' More confirmed words.', speaker: '2', startMs: 1000, endMs: 2000 }] };
  await act(async () => fixture.finishTranscript());
  expect(posts).toHaveLength(1); expect(posts[0].source.complete).toBe(false);
  await act(async () => finishMap()); await flushArchive();
  const saved = fixture.writes.at(-1).snapshot;
  expect(saved.transcript.finalText).toBe(fixture.liveTranscript.finalText);
  expect(saved.map.full_transcript).toBe(transcript.finalText);
  expect(saved.map.transcription_complete).toBe(false);
  expect(container.textContent).toContain('The map covers an earlier snapshot.');
  expect(posts).toHaveLength(1);
});
it('uses the existing automatic cadence to catch up with the completed transcript without an immediate extra call', async () => {
  vi.useFakeTimers(); fixture.holdTranscript = true;
  await mount(); await choose(); await permit(); await click('Create transcript & threads');
  await enableLive(); await click('Generate conversation map');
  fixture.liveTranscript = { ...transcript, finalText: transcript.finalText + ' More confirmed words.',
    finalTokens: [...transcript.finalTokens, { text: ' More confirmed words.', speaker: '2', startMs: 1000, endMs: 2000 }] };
  await act(async () => fixture.finishTranscript());
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(posts).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(45001));
  expect(posts).toHaveLength(2); expect(posts[1].source.complete).toBe(true);
  expect(posts[1].source.finalTokens).toEqual(fixture.liveTranscript.finalTokens);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(fixture.writes.at(-1).snapshot.map.transcription_complete).toBe(true);
  expect(fixture.writes.at(-1).snapshot.map.full_transcript).toBe(fixture.liveTranscript.finalText);
  await act(async () => vi.advanceTimersByTimeAsync(90000)); expect(posts).toHaveLength(2);
});


it.each([401, 502])('honors the speech provider order after OpenAI HTTP %i and passes Settings guidance to the map', async status => {
  const oldFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (path, options) => {
    if (path === 'https://api.openai.com/v1/audio/transcriptions') return new Response('do not expose this', { status });
    if (path === '/api/cloud/map/status') return response({ available: true, personal: true, providers: {} });
    if (path === '/api/cloud/map/generate') {
      const input = JSON.parse(options.body);
      posts.push(input);
      return response({ request_id: '00000000-0000-4000-8000-000000000001', backend: 'anthropic',
        model: 'claude-test', artifact: mapped(input.source) });
    }
    return oldFetch(path, options);
  });
  await mount('/import-audio', { preferences: { speech: ['openai', 'soniox'], map: ['anthropic'],
    models: { anthropic: 'claude-test' }, guidance: 'Surface changes of mind.' },
    keys: { openai: 'synthetic-audio-key', anthropic: 'synthetic-map-key' } });
  expect(container.textContent).toContain('OpenAI → Soniox');
  await choose(); await permit(); await click('Create transcript & threads');
  expect(fetch.mock.calls.filter(([path]) => path === 'https://api.openai.com/v1/audio/transcriptions'), container.textContent).toHaveLength(1);
  if (status === 401) {
    expect(fixture.sessions).toHaveLength(1);
    expect(posts).toEqual([expect.objectContaining({
      routes: [{ backend: 'anthropic', key: 'synthetic-map-key', model: 'claude-test' }],
      guidance: 'Surface changes of mind.',
    })]);
  } else {
    expect(fixture.sessions).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(container.textContent).toContain('OpenAI did not complete transcription (HTTP 502).');
    expect(container.textContent).not.toContain('do not expose this');
  }
});

it('says out loud when the tailnet provider fails and the audio goes to the next provider instead', async () => {
  const oldFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (path, options) => {
    if (path === '/api/cloud/map/status') return response({ available: true, personal: true, providers: {} });
    if (path === '/api/cloud/map/generate') {
      const input = JSON.parse(options.body); posts.push(input);
      return response({ request_id: '00000000-0000-4000-8000-000000000001', backend: 'anthropic', model: 'claude-test', artifact: mapped(input.source) });
    }
    return oldFetch(path, options);
  });
  // An old live-recording link stored another machine on the same tailnet. File imports ignore it and
  // use the address Settings shows: the build default, because Settings is empty here.
  const stale = new URL(DEFAULT_M5_TAILNET_URL); stale.hostname = 'another-machine.' + stale.hostname.split('.').slice(1).join('.');
  localStorage.setItem('lct_stt_edge_url', stale.href);
  await mount('/import-audio', { preferences: { speech: ['m5_tailnet', 'soniox'], map: ['anthropic'], models: { anthropic: 'claude-test' }, guidance: '' },
    keys: { anthropic: 'synthetic-map-key' } });
  const m5 = SPEECH_PROVIDERS.m5_tailnet.name, soniox = SPEECH_PROVIDERS.soniox.name;
  expect(container.textContent).toContain(`${m5} → ${soniox}`);
  await choose(); await permit(); await click('Create transcript & threads'); await flushArchive();
  expect(fixture.m5Urls).toEqual([DEFAULT_M5_TAILNET_URL]);
  expect(fixture.sessions).toHaveLength(1);
  const notice = [...container.querySelectorAll('[role=status]')].map(node => node.textContent).find(text => text.includes('could not transcribe this file'));
  expect(notice).toBe(`${m5} could not transcribe this file (M5 Tailnet STT returned HTTP 503. Your original audio is preserved). `
    + `It was transcribed by ${soniox} instead, the next provider in the order you agreed to.`);
  expect(container.textContent).toContain('Garden watering');
});

it('replaces "Trying the next provider" with the outcome when the next provider fails too', async () => {
  fixture.fail = true;
  const oldFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (path, options) => {
    if (path === '/api/cloud/map/status') return response({ available: true, personal: true, providers: {} });
    return oldFetch(path, options);
  });
  await mount('/import-audio', { preferences: { speech: ['m5_tailnet', 'soniox'], map: ['anthropic'], models: { anthropic: 'claude-test' }, guidance: '' },
    keys: { anthropic: 'synthetic-map-key' } });
  const m5 = SPEECH_PROVIDERS.m5_tailnet.name, soniox = SPEECH_PROVIDERS.soniox.name;
  await choose(); await permit(); await click('Create transcript & threads'); await flushArchive();
  const notice = [...container.querySelectorAll('[role=status]')].map(node => node.textContent).find(text => text.includes('could not transcribe'));
  expect(notice).toBe(`${m5} could not transcribe this file (M5 Tailnet STT returned HTTP 503. Your original audio is preserved). `
    + `${soniox} was tried next and could not transcribe it either.`);
  expect(notice).not.toContain('Trying');
  expect(container.querySelector('[role=alert]').textContent).toContain('Provider refused');

});

