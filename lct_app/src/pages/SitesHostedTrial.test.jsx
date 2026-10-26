// Intent: tests/intent/hosted-attendee-site.md. Synthetic HTTP/media only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SitesHostedTrial from './SitesHostedTrial.jsx';
const BASE = '/api/cloud/hosted-trial', ID = '12345678-1234-4123-8123-123456789abc';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const caption = words => ({ speaker_name: 'Synthetic voice', timestamp_ms: 1793000000000, duration_ms: 1000, transcription: { transcript: words } });
let root, container, server, calls;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); calls = [];
  server = { configured: true, canJoin: true, trial: null, state: 'joined_recording', text: 'Synthetic garden test' };
  const NativeURL = globalThis.URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = () => 'blob:synthetic-transcript'; static revokeObjectURL = () => {}; });
  vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === BASE + '/status') return server.denied ? json({ error: 'Trial owner sign-in required.' }, 401) : json({ configured: server.configured, canJoin: server.canJoin && !server.trial, trial: server.trial, configurationIssues: server.configurationIssues || [] });
    if (path === BASE + '/check') return json({ authenticated: true, emptyProject: true });
    if (path === BASE && options.method === 'POST') {
      server.trial = { requestId: JSON.parse(options.body).requestId, state: server.lost ? 'uncertain' : 'active', leaveAttempted: false };
      if (server.lost) throw new Error('Synthetic lost response');
      return json({ trial: server.trial }, 202);
    }
    if (path === BASE + '/snapshot') {
      if (server.failPoll) throw new Error('Synthetic offline');
      return json({ trial: server.trial, snapshot: { state: server.state, transcript: [caption(server.text)] } });
    }
    if (path === BASE + '/leave') { server.trial.leaveAttempted = true; return json({ message: 'Leave checked.' }); }
    throw new Error('Unexpected synthetic request');
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const btn = name => [...container.querySelectorAll('button')].find(x => x.textContent === name);
const creates = () => calls.filter(x => x.path === BASE && x.options.method === 'POST');
async function mount() { await act(async () => root.render(<MemoryRouter><SitesHostedTrial /></MemoryRouter>)); }
async function click(name) { await act(async () => btn(name).click()); }
async function prepare() { await act(async () => {
  const field = container.querySelector('#hosted-room');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'https://meet.google.com/abc-defg-hij');
  field.dispatchEvent(new Event('input',{bubbles:true})); container.querySelector('input[type=checkbox]').click();
}); }
describe('hosted trial controls', () => {
  it('never sends a bot or key on load/check and requires explicit consent to send', async () => {
    await mount(); expect(creates()).toHaveLength(0); expect(btn('Send test recorder').disabled).toBe(true);
    await click('Check hosted connection'); expect(creates()).toHaveLength(0); expect(container.textContent).toContain('API key accepted');
    await prepare(); await click('Send test recorder'); expect(creates()).toHaveLength(1);
    expect(JSON.parse(creates()[0].options.body)).toMatchObject({ consent: true, meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(calls.every(c => !c.options.headers?.Authorization)).toBe(true);
    expect(container.textContent).toContain('Synthetic garden test');
  });
  it('keeps missing-key, expired-window and unauthenticated views closed without bot dispatch', async () => {
    server.configured = false; server.canJoin = false; await mount();
    expect(btn('Send test recorder').disabled).toBe(true); expect(btn('Check hosted connection').disabled).toBe(true);
    expect(container.textContent).toContain('server secret'); expect(creates()).toHaveLength(0);
  });
  it('names the redacted invalid setup field and keeps dispatch disabled', async () => {
    server.configured = false; server.canJoin = false;
    server.configurationIssues = ['Hosted Attendee API key is missing or has an invalid format.'];
    await mount(); expect(container.textContent).toContain(server.configurationIssues[0]);
    expect(container.textContent).not.toContain('waiting for its server secret');
    expect(btn('Check hosted connection').disabled).toBe(true); expect(btn('Send test recorder').disabled).toBe(true);
    expect(creates()).toHaveLength(0);
  });
  it('retains the original trial after a lost response and only reads it on reload/reconnect', async () => {
    server.lost = true; await mount(); await prepare(); await click('Send test recorder');
    expect(creates()).toHaveLength(1); expect(container.querySelector('form')).toBeNull();
    await click('Refresh recording'); expect(creates()).toHaveLength(1); expect(container.textContent).toContain('Synthetic garden test');
  });
  it('replaces captions, preserves them on disconnect and resumes through a read-only refresh', async () => {
    server.trial = { requestId: ID, state: 'active', leaveAttempted: false }; await mount();
    expect(container.textContent.match(/Synthetic garden test/g)).toHaveLength(1);
    server.failPoll = true; await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.textContent).toContain('Synthetic offline'); expect(container.textContent).toContain('Synthetic garden test');
    server.failPoll = false; server.text = 'A new synthetic caption'; await click('Refresh recording');
    expect(container.textContent).toContain('A new synthetic caption'); expect(container.textContent).not.toContain('Synthetic garden test');
    expect(container.textContent).toContain('received: 2'); expect(creates()).toHaveLength(0);
  });
  it('offers local transcript and completed audio downloads without autoplay or another create', async () => {
    server.trial = { requestId: ID, state: 'ended', leaveAttempted: true }; server.state = 'ended'; await mount();
    expect(container.querySelector('a[download="lct-hosted-trial-transcript.json"]').href).toBe('blob:synthetic-transcript');
    expect(container.querySelector('a[download="lct-hosted-trial.mp3"]').getAttribute('href')).toBe(BASE + '/audio');
    expect(container.querySelector('audio').hasAttribute('autoplay')).toBe(false);
    expect(container.querySelector('audio').getAttribute('preload')).toBe('none'); expect(creates()).toHaveLength(0);
  });
});
