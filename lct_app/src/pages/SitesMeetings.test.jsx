// Intent: tests/intent/sites-meetings.md. Synthetic meeting/identity/audio only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ saved: [], restored: null }));
vi.mock('../services/cloud/localConversationStore.js', () => ({
  readLocalConversation: async () => fixture.restored,
  saveLocalConversation: async (snapshot, chunks) => { fixture.saved.push({ snapshot, chunks }); return 'synthetic-revision'; },
}));
vi.mock('../components/MinimalGraph.jsx', () => ({ default: ({ graphData }) => <div aria-label="Rendered graph">{graphData.map(node => <span key={node.id}>{node.node_name}</span>)}</div> }));
import SitesMeetings from './SitesMeetings.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';

const id = '00000000-0000-4000-8000-000000000001', zero = 1_700_000_000_000;
const BASE = '/api/cloud/meetings';
const row = { id, state: 'active', createdAt: zero, endsAt: zero + 300000 };
const snapshot = { id: 'bot_abcdefghijklmnop', state: 'joined_recording', recording_state: 'in_progress', start_timestamp_ms: zero, audio_available: false,
  utterances: [{ id: '1', text: 'Let us plant an orchard.', speaker: 'Speaker A', speaker_id: 'par_aaaaaaaaaaaaaaaa', timestamp_ms: zero + 1000, duration_ms: 2000 }] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let root, container, server, calls;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); localStorage.clear(); fixture.saved = []; fixture.restored = null;
  server = { canJoin: true, status: 200, createStatus: 202, state: 'active', snapshot: structuredClone(snapshot), failPoll: false }; calls = [];
  const NativeURL = globalThis.URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = () => 'blob:fixture'; static revokeObjectURL = () => {}; });
  vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === BASE + '/status') return json(server.status === 200 ? { enabled: true, canJoin: server.canJoin } : { error: 'Sign in to use private meeting recordings.' }, server.status);
    if (path === BASE && options.method === 'POST') {
      const input = JSON.parse(options.body); server.id = input.requestId;
      if (server.createStatus === 503) throw new Error('Synthetic lost response');
      return json({ meeting: { ...row, id: server.id, state: server.state } }, server.createStatus);
    }
    if (path === BASE) return json({ meetings: [{ ...row, id: server.id || id }] });
    if (path.endsWith('/leave')) { server.state = 'ended'; server.snapshot.state = 'ended'; server.snapshot.recording_state = 'complete'; server.snapshot.audio_available = true; return json({ message: 'Leave requested.' }, 202); }
    if (path.endsWith('/audio')) return new Response(new Uint8Array([73, 68, 51, 1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    if (path.startsWith(BASE + '/')) {
      if (server.failPoll) throw new Error('Synthetic connection lost');
      return json({ meeting: { ...row, id: server.id || id, state: server.state }, ...(server.state === 'uncertain' ? { message: 'Join unconfirmed.' } : { snapshot: server.snapshot }) });
    }
    if (path.endsWith('/status')) return json({ enabled: true, available: true, configured: true, schema_ready: true, audience: 'authenticated', backend: 'openrouter', model: 'synthetic/model', provider: 'Fixture' });
    if (path.endsWith('/generate')) {
      const source = JSON.parse(options.body).source;
      const generated = createRecordingThreads({ ...source, graph: { metadata: { conversation_title: 'Orchard plan' }, nodes: [{ id: 'orchard', node_name: 'Plant an orchard', semantic_type: 'chunk', semantic_level: 1, source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Let us plant an orchard.' }], edges: [] } });
      return json({ request_id: id, artifact: generated.bundle });
    }
    throw new Error('Unexpected request ' + path);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const button = name => [...container.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === name);
async function click(name) { await act(async () => button(name).click()); }
async function tick(ms = 2100) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function mount(path = '/meeting') { await act(async () => root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/meeting" element={<SitesMeetings />} /><Route path="/meeting/:conversationId" element={<SitesMeetings />} /></Routes></MemoryRouter>)); }
async function inputURL() {
  await act(async () => {
    const input = container.querySelector('#meet-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://meet.google.com/abc-defg-hij'); input.dispatchEvent(new Event('input', { bubbles: true }));
    container.querySelector('form input[type=checkbox]').click();
  });
}
const creates = () => calls.filter(call => call.path === BASE && call.options.method === 'POST');
describe('Cloud meeting journey', () => {
  it('never joins on load and requires consent inside an open test window', async () => {
    await mount(); expect(creates()).toHaveLength(0); expect(button('Join and record').disabled).toBe(true);
    await inputURL(); expect(button('Join and record').disabled).toBe(false);
    await click('Join and record'); expect(creates()).toHaveLength(1);
    expect(JSON.parse(creates()[0].options.body)).toMatchObject({ meetingUrl: 'https://meet.google.com/abc-defg-hij', consent: true });
    expect(container.textContent).toContain('Capturing captions and audio');
  });
  it('refuses a closed test window and shows sign-in failures without joining', async () => {
    server.canJoin = false; await mount(); await inputURL(); expect(button('Join and record').disabled).toBe(true);
    expect(container.textContent).toContain('testing window is closed');
    server.status = 401; await click('Check connection'); expect(container.textContent).toContain('Sign in to use'); expect(creates()).toHaveLength(0);
  });
  it('keeps the same reference after a lost join response without sending another bot', async () => {
    server.createStatus = 503; server.state = 'uncertain'; await mount(); await inputURL(); await click('Join and record'); await tick(6100);
    expect(creates()).toHaveLength(1); expect(container.textContent).toContain('Join unconfirmed');
    expect(calls.filter(call => call.path === BASE + '/' + server.id).length).toBeGreaterThan(1);
  });
  it('replaces repeated captions, preserves them during disconnection, and reconnects without a duplicate join', async () => {
    await mount('/meeting/' + id); await tick();
    const history = () => container.querySelector('[aria-label="Transcript history"]').textContent;
    expect(history().match(/Let us plant an orchard/g)).toHaveLength(1);
    expect(history()).toContain('Speaker A'); expect(history()).not.toContain('par_aaaaaaaaaaaaaaaa');
    server.failPoll = true; await tick(); expect(container.textContent).toContain('Synthetic connection lost'); expect(history()).toContain('orchard');
    server.failPoll = false; server.snapshot.utterances.push({ ...snapshot.utterances[0], id: '2', speaker: 'Speaker B', speaker_id: 'par_bbbbbbbbbbbbbbbb', text: 'Start with apples.' }); await click('Reconnect');
    expect(history()).toContain('Start with apples.'); expect(creates()).toHaveLength(0);
  });
  it('generates source-linked threads only after provider consent and saves the map with its transcript', async () => {
    await mount('/meeting/' + id); await click('AI map');
    expect(calls.some(call => call.path.endsWith('/generate'))).toBe(false);
    const consent = [...container.querySelectorAll('label')].find(label => label.textContent.includes('I have permission to send'));
    await act(async () => consent.querySelector('input').click()); await click('Generate conversation map'); await tick(300);
    expect(container.querySelector('[aria-label="Rendered graph"]').textContent).toContain('Plant an orchard');
    expect(fixture.saved.at(-1).snapshot.map.utterances[0]).toMatchObject({ text: 'Let us plant an orchard. ', timestamp_start: 1 });
    expect(creates()).toHaveLength(0);
  });
  it('leaves deliberately, exposes owner audio, and copies the completed audio into the local archive', async () => {
    await mount('/meeting/' + id); await click('Leave recording'); await tick(300); await click('Recording files');
    expect(container.querySelector('audio').getAttribute('src')).toBe(BASE + '/' + id + '/audio');
    const written = fixture.saved.find(entry => entry.chunks.length);
    expect(written.chunks[0].blob.size).toBe(6); expect(written.snapshot.segments[0]).toMatchObject({ complete: true, bytes: 6 });
    expect(calls.filter(call => call.path.endsWith('/leave'))).toHaveLength(1);
  });
  it('ephemeral mode keeps the remote recording available without browser writes or automatic audio download', async () => {
    localStorage.setItem('lct.conversation_retention.v1', 'ephemeral');
    server.state = 'ended'; server.snapshot.state = 'ended'; server.snapshot.recording_state = 'complete'; server.snapshot.audio_available = true;
    await mount('/meeting/' + id); await tick(300); await click('Recording files');
    expect(container.querySelector('audio')).not.toBeNull(); expect(fixture.saved).toHaveLength(0);
    expect(calls.filter(call => call.path.endsWith('/audio'))).toHaveLength(0);
  });
  it('opens a saved transcript while the recorder is offline and does not rewrite unchanged polls', async () => {
    fixture.restored = { id, recording: { id, startedAt: zero, transcribe: true, retention: 'local' }, transcript: { finalText: 'Saved orchard.', finalTokens: [{ text: 'Saved orchard.', speaker: 'local' }], partialText: '', partialTokens: [] }, stage: 'stopped', map: null, segments: [], revision: 'saved' };
    server.failPoll = true; await mount('/meeting/' + id);
    expect(container.querySelector('[aria-label="Transcript history"]').textContent).toContain('Saved orchard.');
    expect(fixture.saved).toHaveLength(0);
    server.failPoll = false; await click('Reconnect'); await tick(300); const writes = fixture.saved.length;
    await tick(6100); expect(fixture.saved).toHaveLength(writes);
  });
  it('preserves an unreadable local map while still showing its saved transcript', async () => {
    fixture.restored = { id, recording: { id, startedAt: zero, transcribe: true, retention: 'local' }, transcript: { finalText: 'Saved orchard.', finalTokens: [{ text: 'Saved orchard.', speaker: 'local' }], partialText: '', partialTokens: [] }, stage: 'stopped', map: null, mapUnreadable: true, segments: [], revision: 'saved' };
    server.failPoll = true; await mount('/meeting/' + id); await tick(300);
    expect(container.querySelector('[aria-label="Transcript history"]').textContent).toContain('Saved orchard.');
    expect(container.textContent).toContain('Its local copy is unchanged'); expect(fixture.saved).toHaveLength(0);
  });
  it('closing the viewer does not leave the bot or create a second meeting', async () => {
    await mount('/meeting/' + id); await act(async () => root.unmount()); root = { unmount() {} }; await tick(10000);
    expect(calls.some(call => call.path.endsWith('/leave'))).toBe(false); expect(creates()).toHaveLength(0);
  });
});
