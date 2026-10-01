// Test Intent: tests/intent/sites-soniox.md; browser UI wiring with synthetic audio only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sessions: [] }));
vi.mock('../services/cloud/recordingSession.js', () => ({ RecordingSession: class {
  constructor(callbacks) { this.callbacks = callbacks; fixture.sessions.push(this); this.cancelled = false; }
  async start(options) { this.options = options; this.callbacks.onStage({ stage: 'recording', message: options.transcribe ? 'Recording and transcribing.' : 'Recording locally.', startedAt: Date.now() }); }
  async stop() { this.callbacks.onAudio({ blob: new Blob(['synthetic audio'], { type: 'audio/webm' }), mimeType: 'audio/webm', complete: true }); this.callbacks.onStage({ stage: 'stopped', message: 'Recording complete.', startedAt: Date.now() }); }
  cancel() { this.cancelled = true; }
} }));
import SitesNewConversation from './SitesNewConversation.jsx';

let root, container, transcribe, privateUploads, createURL, revokeURL;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; fixture.sessions = []; transcribe = false; privateUploads = false;
  localStorage.clear(); createURL = vi.fn(() => 'blob:synthetic-audio'); revokeURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: revokeURL });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } }); vi.stubGlobal('MediaRecorder', class {});
  vi.stubGlobal('fetch', vi.fn(async path => new Response(JSON.stringify(path.includes('soniox')
    ? { enabled: transcribe, audience: 'public', max_session_seconds: 300 }
    : { enabled: true, configured: true, synthetic_only: !privateUploads }), { status: 200 })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const button = name => [...container.querySelectorAll('button')].find(element => element.textContent === name);
async function click(name) { await act(async () => button(name).click()); }
async function mount() { await act(async () => root.render(<MemoryRouter initialEntries={['/new?autostart=true']}><SitesNewConversation /></MemoryRouter>)); }
async function consent() { await act(async () => container.querySelector('input[type=checkbox]').click()); }

describe('Sites recording page', () => {
  it('opens publicly without auto microphone/start or legacy backend requests', async () => {
    await mount();
    expect(container.textContent).toContain('without signing in');
    expect(container.textContent).toContain('Nothing is published automatically');
    expect(button('Record audio locally').disabled).toBe(true);
    expect(button('Record and transcribe').disabled).toBe(true);
    expect(fixture.sessions).toHaveLength(0);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/cloud/soniox/status', '/api/cloud/files/status']);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('records locally after consent and exposes bounded audio with cloud save inactive', async () => {
    await mount(); await consent(); await click('Record audio locally');
    expect(fixture.sessions[0].options).toEqual({ transcribe: false, maxSessionSeconds: 300 });
    expect(container.textContent).toContain('Recording locally');
    await click('Stop recording');
    expect(container.querySelector('audio').getAttribute('src')).toBe('blob:synthetic-audio');
    expect(container.textContent).toContain('This copy is only in this tab');
    expect(button('Save audio privately').disabled).toBe(true);
    expect(fetch.mock.calls.map(call => call[0])).not.toContain('/api/cloud/soniox/session');
  });

  it('shows live/final transcript output without publishing it automatically', async () => {
    transcribe = true; await mount(); await consent(); await click('Record and transcribe');
    expect(fixture.sessions[0].options.transcribe).toBe(true);
    await act(async () => fixture.sessions[0].callbacks.onTranscript({ finalText: 'Final words.', partialText: ' tentative', finalTokens: [], partialTokens: [] }));
    expect(container.textContent).toContain('Final words. tentative');
    expect(container.querySelector('#final-transcript').value).toBe('Final words.');
    expect(fetch.mock.calls).toHaveLength(2);
  });

  it('saves audio through the existing authenticated private-file API only after a deliberate choice', async () => {
    privateUploads = true; await mount(); await consent(); await click('Record audio locally'); await click('Stop recording');
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
    privateUploads = true; await mount(); await consent(); await click('Record audio locally'); await click('Stop recording');
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click('Save audio privately'); expect(container.textContent).toContain('Saving audio to your private files');
    await click('Cancel private save');
    expect(container.textContent).toContain('check your private files before retrying');
    expect(container.querySelector('audio')).toBeTruthy(); expect(button('Save audio privately').disabled).toBe(false);
  });

  it('cancels on navigation and releases local playback URLs without late callback leakage', async () => {
    await mount(); await consent(); await click('Record audio locally'); await click('Stop recording');
    const active = fixture.sessions[0];
    await act(async () => root.unmount()); root = null;
    expect(active.cancelled).toBe(true); expect(revokeURL).toHaveBeenCalledWith('blob:synthetic-audio');
    await act(async () => active.callbacks.onAudio({ blob: new Blob(['late']), mimeType: 'audio/webm', complete: false }));
    expect(createURL).toHaveBeenCalledTimes(1);
    const receipts = JSON.parse(localStorage.getItem('lct.recording_timing.v1'));
    expect(receipts.length).toBeLessThanOrEqual(12);
    expect(Object.keys(receipts[0]).sort()).toEqual(['durationMs', 'mode', 'outcome', 'retryCount', 'stage']);
  });
});
