// Test Intent: tests/intent/sites-soniox.md, sites-recording-transcript.md, sites-private-retention.md, sites-recording-map.md, sites-compact-recording.md and sites-recording-layout.md, sites-live-workspace.md; synthetic audio/tokens only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sessions: [] }));
vi.mock('../components/MinimalGraph.jsx', () => ({ default: ({ graphData }) => <div aria-label="Rendered graph">{graphData.map(n => <span key={n.id}>{n.node_name}</span>)}</div> }));
vi.mock('../services/cloud/recordingSession.js', () => ({ RecordingSession: class {
  constructor(callbacks) { this.callbacks = callbacks; fixture.sessions.push(this); this.cancelled = false; }
  async start(options) { this.options = options; this.callbacks.onStage({ stage: 'recording', message: options.transcribe ? 'Recording and transcribing.' : 'Recording locally.', startedAt: Date.now() }); }
  async stop() { this.callbacks.onAudio({ blob: new Blob(['synthetic audio'], { type: 'audio/webm' }), mimeType: 'audio/webm', complete: true }); this.callbacks.onStage({ stage: 'stopped', message: 'Recording complete.', startedAt: Date.now() }); }
  cancel() { this.cancelled = true; }
} }));
import SitesNewConversation from './SitesNewConversation.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
import { readGeneratedMap } from '../services/cloud/generatedMapHandoff.js';

let root, container, transcribe, privateUploads, generation, createURL, revokeURL;
const dialogMethods = Object.fromEntries(['showModal', 'close'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function generated(source) {
  return createRecordingThreads({ ...source, graph: { metadata: { conversation_title: 'Synthetic generated recording' }, nodes: [
    { id: 'synthetic-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Synthetic recorded moment',
      source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Hello there.' },
  ], edges: [] } });
}
function LocationProbe() { return <output data-testid="location">{JSON.stringify(useLocation().state)}</output>; }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; fixture.sessions = []; transcribe = false; privateUploads = false; generation = false;
  localStorage.clear(); createURL = vi.fn(() => 'blob:synthetic-audio'); revokeURL = vi.fn();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function () { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function () { this.open = false; }) });
  const NativeURL = globalThis.URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = createURL; static revokeObjectURL = revokeURL; });
  window.history.replaceState(null, '', '/new?autostart=true');
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } }); vi.stubGlobal('MediaRecorder', class {});
  vi.stubGlobal('fetch', vi.fn(async (path, options) => ['/api/cloud/openrouter/status', '/api/cloud/gemini/status'].includes(path) ? jsonResponse({ backend: path.includes('/gemini/') ? 'gemini' : 'openrouter', enabled: generation, available: generation,
    configured: generation, schema_ready: generation, audience: 'public', model: 'fixture/model', provider: 'Fixture provider' })
    : ['/api/cloud/openrouter/generate', '/api/cloud/gemini/generate'].includes(path) ? jsonResponse({ request_id: '00000000-0000-4000-8000-000000000001', artifact: generated(JSON.parse(options.body).source).bundle })
    : new Response(JSON.stringify(path.includes('soniox')
    ? { enabled: transcribe, audience: 'public', max_session_seconds: 300 }
    : { enabled: true, configured: true, synthetic_only: !privateUploads }), { status: 200 })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root.unmount()); container?.remove();
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else delete HTMLDialogElement.prototype[name];
  }
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
const button = name => [...container.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || element.textContent) === name);
async function click(name) { await act(async () => button(name).click()); }
async function mount(browser = false) {
  const Router = browser ? BrowserRouter : MemoryRouter;
  await act(async () => root.render(<Router {...(browser ? {} : { initialEntries: ['/new?autostart=true'] })}><SitesNewConversation /><LocationProbe /></Router>));
}
async function consent() { await act(async () => container.querySelector('dialog input[type=checkbox]').click()); }
const transcriptionSwitch = () => container.querySelector('input[role=switch]');
async function chooseTranscription(enabled) {
  if (transcriptionSwitch().checked !== enabled) await act(async () => transcriptionSwitch().click());
}
async function record(name = 'Record audio locally') {
  const enabled = name === 'Record and transcribe';
  await chooseTranscription(enabled); await click('Start session'); await consent(); await click(enabled ? 'Start transcription' : 'Start recording');
}
const transcript = {
  finalText: 'Hello there. Again.', partialText: ' provisional',
  finalTokens: [
    { text: 'Hello there.', speaker: 'S1', startMs: 1250, endMs: 2250 },
    { text: ' Again.', speaker: 'S2', startMs: 2500, endMs: 3000 },
  ],
  partialTokens: [{ text: ' provisional', speaker: 'S2', startMs: 3100, endMs: null }],
};
async function deliverTranscript(value = transcript) {
  await act(async () => fixture.sessions.at(-1).callbacks.onTranscript(value));
}
async function failWithoutAudio() {
  await act(async () => fixture.sessions.at(-1).callbacks.onStage({ stage: 'error', message: 'Capture failed.', startedAt: Date.now() }));
}
function transcriptJSON() { return JSON.parse(container.querySelector('#recording-transcript-json').value); }
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

describe('Sites recording page', () => {
  it('uses one Start control for the selected mode without capturing or transmitting on a switch change', async () => {
    transcribe = true; await mount();
    expect(transcriptionSwitch().checked).toBe(true);
    expect(container.querySelectorAll('[aria-label="Start session"]')).toHaveLength(1);
    expect(container.textContent).toContain('Audio + live transcript');
    await chooseTranscription(false);
    expect(container.textContent).toContain('Audio only');
    expect(fixture.sessions).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    await click('Start session');
    expect(container.querySelector('dialog').textContent).not.toContain('Soniox');
    await click('Cancel');
    expect(transcriptionSwitch().checked).toBe(false);
    await chooseTranscription(true); await click('Start session');
    expect(container.querySelector('dialog').textContent).toContain('send this audio to Soniox');
    expect(fixture.sessions).toHaveLength(0);
    await consent(); await click('Start transcription');
    expect(fixture.sessions[0].options.transcribe).toBe(true);
    expect(transcriptionSwitch()).toBeNull();
    expect(button('Start session')).toBeUndefined();
    expect(document.activeElement).toBe(button('Stop recording'));
  });

  it('refuses unavailable selected transcription and keeps an explicit audio-only choice after recovery', async () => {
    transcribe = true; await mount();
    await click('Start session'); await click('Cancel');
    transcribe = false; await click('Retry cloud setup');
    expect(transcriptionSwitch().checked).toBe(true);
    expect(transcriptionSwitch().disabled).toBe(false);
    expect(button('Start session').disabled).toBe(true);
    await click('Start session');
    expect(container.querySelector('dialog')).toBeNull();
    expect(fixture.sessions).toHaveLength(0);
    await chooseTranscription(false);
    expect(button('Start session').disabled).toBe(false);
    transcribe = true; await click('Retry cloud setup');
    expect(transcriptionSwitch().checked).toBe(false);
    await click('Start session'); await consent(); await click('Start recording');
    expect(fixture.sessions[0].options.transcribe).toBe(false);
  });

  it('keeps consent and selected mode fixed when setup completes after opening the audio-only dialog', async () => {
    let finish;
    fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    expect(transcriptionSwitch().checked).toBe(false);
    await click('Start session');
    await act(async () => finish(jsonResponse({ enabled: true, audience: 'public', max_session_seconds: 300 })));
    expect(transcriptionSwitch().checked).toBe(false);
    expect(container.querySelector('dialog').textContent).not.toContain('Soniox');
    await consent(); await click('Start recording');
    expect(fixture.sessions[0].options.transcribe).toBe(false);
  });

  it('keeps the recording toolbar outside the scrolling canvas across idle, capture and local results', async () => {
    await mount();
    const canvas = container.querySelector('[aria-label="Conversation canvas"]');
    const controls = container.querySelector('[aria-label="Recording controls"]');
    expect(canvas).toBeTruthy();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.contains(controls)).toBe(false);
    expect(container.querySelector('footer').contains(controls)).toBe(true);
    expect(canvas.textContent).toContain('Start recording below');
    expect(controls.textContent).toContain('Start');
    expect(button('Start session').querySelector('svg')).toBeTruthy();
    expect(container.querySelector('h1').textContent).toBe('New conversation');
    await record();
    expect(container.querySelector('footer').contains(button('Stop recording'))).toBe(true);
    expect(canvas.textContent).toContain('Your threads will take shape here');
    await click('Stop recording');
    expect(canvas.contains(container.querySelector('audio'))).toBe(true);
    expect(canvas.contains(container.querySelector('a[download$=".webm"]'))).toBe(true);
    expect(container.querySelector('footer').contains(button('Start session'))).toBe(true);
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('keeps stalled setup and recovery within the scrolling canvas, outside the control bar', async () => {
    vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {})); await mount();
    const canvas = container.querySelector('[aria-label="Conversation canvas"]');
    const footer = container.querySelector('footer');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(canvas.textContent).toContain('2 s elapsed');
    expect(canvas.contains(button('Cancel setup'))).toBe(true);
    expect(footer.textContent).not.toContain('Time remaining unknown');
    expect(footer.textContent).not.toContain('Live transcription is not available');
    await click('Cancel setup');
    expect(canvas.contains(button('Retry cloud setup'))).toBe(true);
    expect(button('Retry cloud setup').closest('details')).toBeNull();
    expect(footer.contains(button('Start session'))).toBe(true);
  });

  it('opens publicly without auto microphone/start or legacy backend requests', async () => {
    await mount();
    expect(container.textContent).toContain('without signing in');
    expect(container.textContent).not.toContain('Nothing is published automatically');
    expect(button('Start session').disabled).toBe(false);
    expect(transcriptionSwitch().checked).toBe(false);
    expect(transcriptionSwitch().disabled).toBe(true);
    expect(container.querySelectorAll('[aria-label="Start session"]')).toHaveLength(1);
    expect(button('Retry cloud setup').closest('details')).toBeNull();
    expect(fixture.sessions).toHaveLength(0);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/cloud/soniox/status', '/api/cloud/files/status']);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('asks for fresh local permission only on Record, and cancelling or Escape never starts capture', async () => {
    await mount();
    expect(container.querySelector('dialog')).toBeNull();
    button('Start session').focus(); await click('Start session');
    expect(container.querySelector('dialog').open).toBe(true);
    expect(container.querySelector('dialog').textContent).not.toContain('Nothing is published automatically');
    expect(document.activeElement).toBe(container.querySelector('dialog input'));
    expect(container.querySelector('dialog').textContent).not.toContain('Soniox');
    expect(button('Start recording').disabled).toBe(true);
    await click('Start recording'); expect(fixture.sessions).toHaveLength(0);
    await consent(); await click('Cancel');
    expect(container.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Start session'));
    expect(localStorage.getItem('lct.recording_intro.v1')).toBeNull();
    await click('Start session');
    expect(container.querySelector('dialog input').checked).toBe(false);
    await act(async () => container.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(container.querySelector('dialog')).toBeNull(); expect(fixture.sessions).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(call => call[1]?.method).filter(Boolean)).not.toContain('POST');
  });

  it('remembers only the introduction, then asks again after stopping without replacing audio on cancellation', async () => {
    await mount(); await record();
    expect(localStorage.getItem('lct.recording_intro.v1')).toBe('seen');
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    expect(button('Start session')).toBeUndefined();
    expect(button('Cancel session')).toBeTruthy();
    expect(document.activeElement).toBe(button('Stop recording'));
    expect(container.textContent).not.toContain('Live transcription is not available yet');
    await click('Stop recording');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click('Start session');
    expect(container.querySelector('dialog input').checked).toBe(false);
    expect(container.querySelector('dialog').textContent).not.toContain('Your recording stays in this tab');
    expect(container.querySelector('dialog').textContent).toContain('5 minutes or 2 MiB');
    await click('Cancel');
    expect(container.querySelector('audio').getAttribute('src')).toBe('blob:synthetic-audio');
    expect(fixture.sessions).toHaveLength(1);
    await record(); expect(fixture.sessions).toHaveLength(2);
  });

  it('requires fresh Soniox permission even with the introduction remembered', async () => {
    transcribe = true; localStorage.setItem('lct.recording_intro.v1', 'seen'); await mount();
    await click('Start session');
    expect(container.querySelector('dialog').textContent).toContain('Audio streams to Soniox');
    expect(container.querySelector('dialog').textContent).toContain('send this audio to Soniox for transcription');
    expect(container.querySelector('dialog input').checked).toBe(false);
    expect(button('Start transcription').disabled).toBe(true); expect(fixture.sessions).toHaveLength(0);
    await consent(); await click('Start transcription');
    expect(fixture.sessions[0].options.transcribe).toBe(true);
  });

  it('keeps Stop focused and Cancel reachable while recording finalizes', async () => {
    await mount(); await record();
    await act(async () => fixture.sessions[0].callbacks.onStage({ stage: 'finalizing', message: 'Finalizing recording.', startedAt: Date.now() }));
    expect(button('Stop recording').disabled).toBe(false);
    expect(document.activeElement).toBe(button('Stop recording'));
    expect(button('Cancel session').disabled).toBe(false);
    expect(container.textContent).toContain('Finalizing recording.');
    expect(container.textContent).toContain('Time remaining unknown');
    await click('Cancel session'); expect(fixture.sessions[0].cancelled).toBe(true);
  });

  it('works with blocked browser storage and cancels a pending dialog on navigation', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    await mount(); await record(); expect(fixture.sessions).toHaveLength(1);
    await failWithoutAudio(); await click('Start session'); await consent();
    await act(async () => root.unmount()); root = null;
    expect(fixture.sessions).toHaveLength(1); expect(container.querySelector('dialog')).toBeNull();
  });

  it('records locally after consent and exposes bounded audio with cloud save inactive', async () => {
    await mount(); await record();
    expect(fixture.sessions[0].options).toEqual({ transcribe: false, maxSessionSeconds: 300 });
    expect(container.textContent).toContain('Recording locally');
    await click('Stop recording');
    expect(container.querySelector('audio').getAttribute('src')).toBe('blob:synthetic-audio');
    expect(container.textContent).toContain('This copy is only in this tab');
    expect(button('Save audio privately').disabled).toBe(true);
    expect(fetch.mock.calls.map(call => call[0])).not.toContain('/api/cloud/soniox/session');
  });

  it('shows live/final transcript output without publishing it automatically', async () => {
    transcribe = true; await mount(); await record('Record and transcribe');
    expect(fixture.sessions[0].options.transcribe).toBe(true);
    await act(async () => fixture.sessions[0].callbacks.onTranscript({ finalText: 'Final words.', partialText: ' tentative', finalTokens: [{ text: 'Final words.', speaker: null, startMs: 0, endMs: 1000 }], partialTokens: [] }));
    expect(container.textContent).toContain('Final words. tentative');
    expect(container.querySelector('#final-transcript')).toBeNull();
    expect(container.querySelectorAll('[aria-label="Live transcript"]')).toHaveLength(1);
    expect(button('Copy transcript')).toBeTruthy();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('saves audio through the existing authenticated private-file API only after a deliberate choice', async () => {
    privateUploads = true; await mount(); await record(); await click('Stop recording');
    const describedBy = button('Save audio privately').getAttribute('aria-describedby');
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe('Private cloud copies stay until you delete them. Saving privately does not publish them.');
    expect(fetch.mock.calls.map(call => call[1]?.method).filter(Boolean)).not.toContain('POST');
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ file: { id: 'synthetic-private' } }), { status: 201 }));
    await click('Save audio privately');
    const [path, options] = fetch.mock.lastCall;
    expect(path).toBe('/api/cloud/files'); expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin'); expect(options.headers['X-LCT-Storage-Write']).toBe('1');
    expect(options.body).toBeInstanceOf(File); expect(options.body.size).toBe(new Blob(['synthetic audio']).size);
    expect(options.body.type).toBe('audio/webm');
    expect(container.textContent).toContain('Audio saved to your private cloud files');
  });

  it('makes stalled setup elapsed/cancellable and allows a successful explicit retry', async () => {
    vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.textContent).toContain('Time remaining unknown');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain('2 s elapsed');
    await click('Cancel setup');
    expect(container.textContent).toContain('Setup stopped or timed out');
    fetch.mockImplementation(async () => new Response(JSON.stringify({ enabled: false, synthetic_only: true })));
    await click('Retry cloud setup');
    expect(button('Retry cloud setup')).toBeTruthy(); expect(button('Cancel setup')).toBeUndefined();
  });

  it('bounds setup without relying on fetch honoring the abort signal', async () => {
    vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {})); await mount();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).toContain('Setup stopped or timed out');
    expect(button('Cancel setup')).toBeUndefined();
    expect(button('Retry cloud setup')).toBeTruthy();
  });

  it('keeps local audio and warns about uncertain private-save outcome after cancellation', async () => {
    transcribe = true; privateUploads = true; await mount(); await record(); await click('Stop recording');
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click('Save audio privately'); expect(container.textContent).toContain('Saving audio to your private files');
    await click('Cancel private save');
    expect(container.textContent).toContain('check your private files before retrying');
    expect(container.querySelector('audio')).toBeTruthy(); expect(button('Save audio privately').disabled).toBe(false);
    expect(button('Retry cloud setup').closest('details')).toBeNull();
    expect(button('Save audio privately').textContent).toBe('Save audio privately');
  });

  it('cancels on navigation and releases local playback URLs without late callback leakage', async () => {
    await mount(); await record(); await click('Stop recording');
    const active = fixture.sessions[0];
    await act(async () => root.unmount()); root = null;
    expect(active.cancelled).toBe(true); expect(revokeURL).toHaveBeenCalledWith('blob:synthetic-audio');
    await act(async () => active.callbacks.onAudio({ blob: new Blob(['late']), mimeType: 'audio/webm', complete: false }));
    expect(createURL).toHaveBeenCalledTimes(1);
    const receipts = JSON.parse(localStorage.getItem('lct.recording_timing.v1'));
    expect(receipts.length).toBeLessThanOrEqual(12);
    expect(Object.keys(receipts[0]).sort()).toEqual(['durationMs', 'mode', 'outcome', 'retryCount', 'stage']);
  });

  it('offers a live transcript snapshot, then matching audio and completed transcript after stopping, without publishing', async () => {
    transcribe = true; await mount(); await record('Record and transcribe');
    await deliverTranscript();
    expect(container.querySelector('[aria-label="Transcript file"]')).toBeTruthy();
    expect(transcriptJSON().transcription_complete).toBe(false);
    expect(button('Save transcript privately').disabled).toBe(true);
    expect(createURL).toHaveBeenCalledWith(expect.any(File));
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    await click('Stop recording');
    const audioName = container.querySelector('a[download$=".webm"]').getAttribute('download');
    const transcriptName = container.querySelector('a[download$=".transcript.json"]').getAttribute('download');
    const recordingId = audioName.match(/^recording-(.+)\.webm$/)?.[1];
    expect(recordingId).toBeTruthy();
    expect(transcriptName).toBe(`recording-${recordingId}.transcript.json`);
    expect(transcriptJSON()).toMatchObject({
      recording_id: recordingId, transcription_complete: true, full_transcript: 'Hello there. Again.',
      utterances: [
        { speaker_id: 'S1', text: 'Hello there.', timestamp_start: 1.25, timestamp_end: 2.25, duration_seconds: 1 },
        { speaker_id: 'S2', text: ' Again.', timestamp_start: 2.5, timestamp_end: 3, duration_seconds: 0.5 },
      ],
    });
    expect(transcriptJSON().source_tokens.map(token => token.text)).toEqual(['Hello there.', ' Again.']);
    const audioDescription = button('Save audio privately').getAttribute('aria-describedby');
    const transcriptDescription = button('Save transcript privately').getAttribute('aria-describedby');
    expect(audioDescription).not.toBe(transcriptDescription);
    expect(container.querySelector(`#${audioDescription}`)?.textContent).toContain('stay until you delete them');
    expect(container.querySelector(`#${transcriptDescription}`)?.textContent).toContain('Saving privately does not publish them');
    expect(fetch.mock.calls.map(call => call[1]?.method).filter(Boolean)).not.toContain('POST');
  });

  it('sends the actual JSON File through the same-origin private API only on explicit save', async () => {
    transcribe = true; privateUploads = true; await mount(); await record('Record and transcribe');
    await deliverTranscript(); await click('Stop recording');
    const expected = transcriptJSON();
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/cloud/soniox/status', '/api/cloud/files/status', '/api/cloud/openrouter/status']);
    const describedBy = button('Save transcript privately').getAttribute('aria-describedby');
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe('Private cloud copies stay until you delete them. Saving privately does not publish them.');
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ file: { id: 'synthetic-transcript' } }), { status: 201 }));
    await click('Save transcript privately');
    const [path, options] = fetch.mock.lastCall;
    expect(path).toBe('/api/cloud/files');
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-LCT-Storage-Write': '1' });
    expect(options.body).toBeInstanceOf(File);
    expect(options.body.name).toBe(`recording-${expected.recording_id}.transcript.json`);
    expect(options.body.type).toBe('application/json');
    expect(JSON.parse(await readFile(options.body))).toEqual(expected);
    expect(container.textContent).toContain('Transcript saved to your private cloud files');
  });

  it('keeps transcript download available while synthetic storage disables private save', async () => {
    transcribe = true; await mount(); await record('Record and transcribe');
    await deliverTranscript(); await click('Stop recording');
    expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    expect(button('Save transcript privately').disabled).toBe(true);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/cloud/soniox/status', '/api/cloud/files/status', '/api/cloud/openrouter/status']);
  });

  it('retains partial transcript JSON without audio after cancelling a private save', async () => {
    transcribe = true; privateUploads = true; await mount(); await record('Record and transcribe');
    await deliverTranscript(); await failWithoutAudio();
    expect(container.querySelector('audio')).toBeNull();
    expect(transcriptJSON().transcription_complete).toBe(false);
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click('Save transcript privately');
    expect(container.textContent).toContain('Saving transcript to your private files');
    await click('Cancel private save');
    expect(container.textContent).toContain('check your private files before retrying');
    expect(transcriptJSON().full_transcript).toBe('Hello there. Again.');
    expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    expect(button('Save transcript privately').disabled).toBe(false);
  });

  it('bounds a transcript-only private save and preserves its local download', async () => {
    transcribe = true; privateUploads = true; await mount(); await record('Record and transcribe');
    await deliverTranscript(); await failWithoutAudio();
    vi.useFakeTimers(); fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click('Save transcript privately');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toContain('check your private files before retrying');
    expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    expect(button('Save transcript privately').disabled).toBe(false);
  });

  it('confirms replacement after transcript-only failure and releases both artifact URLs on navigation', async () => {
    transcribe = true; privateUploads = true;
    createURL.mockImplementationOnce(() => 'blob:transcript-old').mockImplementationOnce(() => 'blob:transcript-new');
    await mount(); await record('Record and transcribe'); await deliverTranscript(); await failWithoutAudio();
    const oldName = container.querySelector('a[download$=".transcript.json"]').getAttribute('download');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click('Start session');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector('a[download$=".transcript.json"]').getAttribute('download')).toBe(oldName);
    expect(fixture.sessions).toHaveLength(1);
    await record('Record and transcribe');
    expect(fixture.sessions).toHaveLength(2);
    expect(container.querySelector('[aria-label="Transcript file"]')).toBeNull();
    expect(revokeURL).toHaveBeenCalledWith('blob:transcript-old');
    await deliverTranscript(); await failWithoutAudio();
    expect(container.querySelector('a[download$=".transcript.json"]').getAttribute('download')).not.toBe(oldName);
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click('Save transcript privately');
    const uploadSignal = fetch.mock.lastCall[1].signal;
    await act(async () => root.unmount()); root = null;
    expect(uploadSignal.aborted).toBe(true);
    expect(revokeURL).toHaveBeenCalledWith('blob:transcript-new');
  });

  async function readyMap(partial = false, browser = false) {
    transcribe = true; generation = true;
    await mount(browser); await record('Record and transcribe'); await deliverTranscript();
    expect(container.querySelector('[aria-label="Conversation map"]')).toBeTruthy();
    expect(generationCalls()).toHaveLength(0);
    if (partial) await failWithoutAudio(); else await click('Stop recording');
  }
  async function permitMap() { await act(async () => container.querySelector('[aria-label="Conversation map"] input').click()); }
  const generationCalls = () => fetch.mock.calls.filter(call => call[0] === '/api/cloud/openrouter/generate');

  it('requires new consent after choosing Gemini and sends only to the selected backend', async () => {
    await readyMap(); await permitMap();
    const selector = container.querySelector('#map-inference-backend');
    expect(selector.value).toBe('openrouter');
    await act(async () => { selector.value = 'gemini'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[aria-label="Conversation map"] input').checked).toBe(false);
    expect(button('Generate conversation map').disabled).toBe(true);
    expect(container.textContent).toContain('Google Gemini through Google AI Studio');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    await permitMap(); await click('Generate conversation map');
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0][0]).toBe('/api/cloud/gemini/generate');
    expect(posts[0][1].headers).toEqual({ 'Content-Type': 'application/json', 'X-LCT-Gemini-Consent': 'generate-v1' });
    expect(container.querySelector('#recording-map-json')).toBeTruthy();
  });

  it('requires separate map processing consent and verifies exact finalized source before offering an unsaved result', async () => {
    await readyMap(false, true);
    expect(button('Generate conversation map').disabled).toBe(true);
    await click('Generate conversation map'); expect(generationCalls()).toHaveLength(0);
    await permitMap(); await click('Generate conversation map');
    const [path, options] = generationCalls()[0];
    expect(path).toBe('/api/cloud/openrouter/generate');
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-LCT-OpenRouter-Consent': 'generate-v1' } });
    const source = JSON.parse(options.body).source;
    expect(source.complete).toBe(true); expect(source.finalTokens).toEqual(transcript.finalTokens);
    expect(JSON.parse(container.querySelector('#recording-map-json').value)).toEqual(generated(source).bundle);
    expect(container.textContent).toContain('Your map is ready in this tab');
    expect(container.querySelector('a[download$=".threads"]').getAttribute('download')).toBe(`recording-${source.recordingId}.threads`);
    expect(button('Save map privately').disabled).toBe(true);
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    await click('Explore map');
    const handoff = JSON.parse(container.querySelector('[data-testid="location"]').textContent);
    expect(handoff).toEqual({ remember: false, generatedMapId: expect.any(String) });
    expect(readGeneratedMap(handoff.generatedMapId)).toEqual(generated(source).bundle);
    expect(window.history.state.usr).toEqual(handoff);
    expect(JSON.stringify(window.history.state)).not.toContain('Hello there.');
  });

  it('keeps partial source explicit and saves only the actual generated map file on deliberate private save', async () => {
    privateUploads = true; await readyMap(true);
    expect(container.textContent).toContain('partial transcript; unfinished words are excluded');
    await permitMap(); await click('Generate conversation map');
    const expected = JSON.parse(container.querySelector('#recording-map-json').value);
    expect(expected.transcription_complete).toBe(false);
    expect(fetch.mock.calls.filter(call => call[0] === '/api/cloud/files' && call[1]?.method === 'POST')).toHaveLength(0);
    fetch.mockImplementationOnce(async () => jsonResponse({ file: { id: 'synthetic-map' } }, 201));
    await click('Save map privately');
    const [path, options] = fetch.mock.lastCall;
    expect(path).toBe('/api/cloud/files'); expect(options.body).toBeInstanceOf(File);
    expect(options.body.name).toBe(`recording-${expected.conversation_id}.threads`);
    expect(JSON.parse(await readFile(options.body))).toEqual(expected);
    expect(container.textContent).toContain('Map saved to your private cloud files');
  });

  it.each([401, 429, 503])('keeps recording downloads and makes no automatic retry after generation HTTP %s', async status => {
    await readyMap(); await permitMap();
    fetch.mockImplementationOnce(async () => jsonResponse({ error: 'fixture upstream detail' }, status));
    await click('Generate conversation map');
    expect(generationCalls()).toHaveLength(1);
    expect(container.querySelector('#recording-map-json')).toBeNull();
    expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    expect(container.textContent).not.toContain('fixture upstream detail');
    await click('Generate conversation map');
    expect(generationCalls()).toHaveLength(2); expect(container.querySelector('#recording-map-json')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('lct.recording_map_timing.v1')).at(-1)).toMatchObject({ stage: 'generate', outcome: 'success', retryCount: 1 });
  });

  it('keeps audio/transcript usable when map status fails and refuses an inactive map without a POST', async () => {
    transcribe = true; await mount(); await record('Record and transcribe'); await deliverTranscript();
    fetch.mockImplementationOnce(async () => jsonResponse({ error: 'fixture unavailable' }, 503)); await click('Retry generation setup'); await click('Stop recording');
    expect(container.textContent).toContain('Generation setup is unavailable');
    expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    expect(button('Start session').disabled).toBe(false);
    await click('Retry generation setup');
    expect(button('Generate conversation map').disabled).toBe(true);
    await click('Generate conversation map'); expect(generationCalls()).toHaveLength(0);
  });

  it.each(['cancel', 'timeout', 'navigation'])('settles stalled generation on %s without accepting a late result or automatic retry', async mode => {
    privateUploads = true; await readyMap(); await permitMap(); vi.useFakeTimers();
    let finish; fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click('Generate conversation map');
    const source = JSON.parse(generationCalls()[0][1].body).source;
    const signal = generationCalls()[0][1].signal;
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(container.textContent).toContain('Generating conversation map · 31s elapsed · Time remaining unknown');
    expect(button('Start session').disabled).toBe(true);
    expect(transcriptionSwitch().disabled).toBe(true);
    expect(button('Save audio privately').disabled).toBe(true);
    expect(button('Save transcript privately').disabled).toBe(true);
    if (mode === 'navigation') { await act(async () => root.unmount()); root = null; }
    else if (mode === 'timeout') await act(async () => vi.advanceTimersByTimeAsync(64_000));
    else await click('Cancel');
    expect(signal.aborted).toBe(true);
    await act(async () => finish(jsonResponse({ request_id: '00000000-0000-4000-8000-000000000001', artifact: generated(source).bundle })));
    expect(generationCalls()).toHaveLength(1); expect(container.querySelector('#recording-map-json')).toBeNull();
    const timings = JSON.parse(localStorage.getItem('lct.recording_map_timing.v1'));
    expect(timings.at(-1)).toMatchObject({ stage: 'generate', outcome: mode === 'timeout' ? 'timeout' : 'cancelled' });
    expect(Object.keys(timings.at(-1)).sort()).toEqual(['durationMs', 'outcome', 'retryCount', 'stage']);
    expect(timings.length).toBeLessThanOrEqual(12);
    if (mode !== 'navigation') {
      expect(container.textContent).toContain('does not confirm billing stopped');
      expect(container.querySelector('a[download$=".transcript.json"]')).toBeTruthy();
    }
    // Drain immediate tasks (nested zero-delay timers fire at least1ms later in the fake clock).
    // App elapsed intervals/deadlines are >=1000ms and would still count as leaks.
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a prior valid map after a deliberately requested replacement fails', async () => {
    await readyMap(); await permitMap(); await click('Generate conversation map');
    const original = container.querySelector('#recording-map-json').value;
    fetch.mockImplementationOnce(async () => jsonResponse({ error: 'fixture failure' }, 502));
    await click('Generate another map');
    expect(container.querySelector('#recording-map-json').value).toBe(original);
    expect(generationCalls()).toHaveLength(2); expect(button('Explore map')).toBeTruthy();
  });
  it('maps finalized words while recording, retains consent on new words, and keeps Pause/Stop available during generation', async () => {
    transcribe = true; generation = true; await mount(); await record('Record and transcribe'); await deliverTranscript(); await permitMap();
    let respond; fetch.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    await click('Generate conversation map');
    const source = JSON.parse(generationCalls()[0][1].body).source;
    expect(source.complete).toBe(false);
    expect(button('Pause recording').disabled).toBe(false); expect(button('Stop recording').disabled).toBe(false);
    const updated = { ...transcript, finalTokens: [...transcript.finalTokens, { text: ' Another point.', speaker: 'S2', startMs: 4000, endMs: 5000 }] };
    await deliverTranscript(updated);
    expect(container.querySelector('[aria-label="Conversation map"] input').checked).toBe(true);
    await act(async () => respond(jsonResponse({ request_id: '00000000-0000-4000-8000-000000000001', artifact: generated(source).bundle })));
    expect(container.querySelector('[aria-label="Rendered graph"]').textContent).toContain('Synthetic recorded moment');
    expect(container.textContent).toContain('New words are waiting');
    await click('Pause recording'); expect(button('Resume recording')).toBeTruthy();
    expect(document.activeElement).toBe(button('Resume recording'));
    const id = transcriptJSON().recording_id;
    await click('Resume recording'); await deliverTranscript({ ...transcript, finalTokens: [{ text: 'Resumed words.', speaker: 'S1', startMs: 10, endMs: 1000 }], partialText: '' });
    expect(transcriptJSON().recording_id).toBe(id);
    expect(transcriptJSON().full_transcript).toBe('Hello there. Again. Another point.\nResumed words.');
    expect(container.querySelector('[aria-label="Rendered graph"]')).toBeTruthy();
    await click('Stop recording');
    expect(container.querySelectorAll('audio')).toHaveLength(2);
    expect(transcriptJSON().transcription_complete).toBe(true);
    await click('Generate another map');
    expect(JSON.parse(container.querySelector('#recording-map-json').value).utterances.at(-1).speaker_id).toBe('segment-2:S1');
  });

  it('uses one expandable transcript panel and copies only confirmed words', async () => {
    transcribe = true; const writeText = vi.fn(async () => {}); navigator.clipboard = { writeText };
    await mount(); await record('Record and transcribe'); await deliverTranscript();
    await click('Copy transcript'); expect(writeText).toHaveBeenCalledWith('Hello there. Again.');
    expect(container.querySelector('#final-transcript')).toBeNull();
    await click('Collapse transcript'); expect(button('Expand transcript')).toBeTruthy();
    await click('Expand transcript'); await click('Full screen transcript'); expect(button('Exit full screen transcript')).toBeTruthy();
    await click('Exit full screen transcript'); expect(button('Pause recording')).toBeTruthy();
  });

  it('schedules bounded live updates despite frequent transcript events, serializes them, and disables automatic retry after failure', async () => {
    transcribe = true; generation = true; await mount(); await record('Record and transcribe'); await deliverTranscript(); await permitMap(); vi.useFakeTimers();
    await act(async () => container.querySelector('[aria-label="Update map while I speak"]').click());
    const longer = { ...transcript, finalTokens: [...transcript.finalTokens, { text: ' We discuss a synthetic community garden, then a reading group, then the decisions needed to make both work. More source words accumulate while recording continues.', speaker: 'S2', startMs: 4000, endMs: 6000 }] };
    let respond; fetch.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    for (let i = 0; i < 4; i++) { await deliverTranscript(longer); await act(async () => vi.advanceTimersByTimeAsync(500)); }
    expect(generationCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(50000)); expect(generationCalls()).toHaveLength(1);
    await act(async () => respond(jsonResponse({ error: 'synthetic refusal' }, 429)));
    expect(container.querySelector('[aria-label="Update map while I speak"]').checked).toBe(false);
    await deliverTranscript({ ...longer, finalTokens: [...longer.finalTokens, { text: ' More words.', speaker: 'S2', startMs: 7000, endMs: 8000 }] });
    await act(async () => vi.advanceTimersByTimeAsync(90000)); expect(generationCalls()).toHaveLength(1);
    expect(container.querySelector('[aria-label="Live transcript"]').textContent).toContain('More words.');
  });

  it('caps automatic attempts at six even with an ongoing transcript and preserves explicit manual control', async () => {
    transcribe = true; generation = true; await mount(); await record('Record and transcribe'); await deliverTranscript(); await permitMap(); vi.useFakeTimers();
    await act(async () => container.querySelector('[aria-label="Update map while I speak"]').click());
    let tokens = [...transcript.finalTokens];
    for (let i = 0; i < 8; i++) {
      tokens = [...tokens, { text: ' Synthetic additional words about a community garden, reading together, and neighborhood projects. We follow one more thread as the conversation develops.', speaker: 'S2', startMs: 4000 + i * 1000, endMs: 5000 + i * 1000 }];
      await deliverTranscript({ ...transcript, finalTokens: tokens });
      await act(async () => vi.advanceTimersByTimeAsync(46000));
    }
    expect(generationCalls()).toHaveLength(6);
    expect(container.querySelector('[aria-label="Update map while I speak"]').disabled).toBe(true);
    expect(button('Pause recording')).toBeTruthy();
    await click('Generate another map'); expect(generationCalls()).toHaveLength(7);
  });

  it('marks an unchanged live snapshot complete on Stop without another provider request', async () => {
    transcribe = true; generation = true; await mount(); await record('Record and transcribe'); await deliverTranscript(); await permitMap();
    await click('Generate conversation map');
    expect(JSON.parse(container.querySelector('#recording-map-json').value).transcription_complete).toBe(false);
    await click('Stop recording');
    expect(JSON.parse(container.querySelector('#recording-map-json').value).transcription_complete).toBe(true);
    expect(generationCalls()).toHaveLength(1);
  });

});
