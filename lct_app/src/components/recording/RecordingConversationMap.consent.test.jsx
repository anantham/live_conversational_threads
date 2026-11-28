// Test intent (review fixes, 2026-11-27):
// - With personal keys on every route, permission to send words is assumed and live updates start by
//   themselves, once. The permission box can still be unticked, and unticking stops everything.
// - A chain that includes a site-key route is not "personal": it needs the tick box, as a site key always has.
// - A failed automatic update switches automatic updates off, and they stay off.
// - A map opened from this device counts as covering its own transcript.
// Synthetic words and keys only; the provider is a fetch stub.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordingConversationMap from './RecordingConversationMap.jsx';
import { SitesRuntimeContext } from '../../contexts/SitesRuntimeContext';
import { createRecordingThreads } from '../../services/cloud/recordingThreads.js';

const words = ' We discuss a synthetic community garden, then a reading group, then the decisions needed to make both work. More source words accumulate while recording continues.';
const source = (extra = '') => ({ recordingId: '00000000-0000-4000-8000-0000000000aa', startedAt: 1, complete: false, finalTokens: [
  { text: 'Hello there.', speaker: 'S1', startMs: 0, endMs: 900 },
  { text: words + extra, speaker: 'S2', startMs: 1000, endMs: 9000 },
] });
const mapped = input => createRecordingThreads({ ...input, graph: { metadata: { conversation_title: 'Synthetic map' }, nodes: [
  { id: 'synthetic-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Synthetic moment',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Hello there.' }], edges: [] } }).bundle;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const personal = { credentialsReady: true, keys: { anthropic: 'synthetic-anthropic-key' },
  preferences: { map: ['anthropic'], models: {}, guidance: '', mapChain: [{ backend: 'anthropic', model: 'claude-test' }] } };
const mixed = { ...personal, preferences: { ...personal.preferences, mapChain: [{ backend: 'anthropic', model: 'claude-test' }, { backend: 'openrouter', model: '' }] } };

let root, container, generate, schedule;
const generateCalls = () => fetch.mock.calls.filter(([path]) => path === '/api/cloud/map/generate');
const box = label => [...container.querySelectorAll('label')].find(el => el.textContent.includes(label)).querySelector('input');
const permission = () => box('I have permission');
const automatic = () => box('Update map while I speak');
const tick = ms => act(async () => vi.advanceTimersByTimeAsync(ms));
// Fake timers from the start: automatic updates begin at mount, and their clock must be the one the test drives.
async function mount(runtime, props = {}) {
  await act(async () => root.render(<SitesRuntimeContext.Provider value={runtime}><MemoryRouter>
    <RecordingConversationMap source={source()} saving={false} liveActive onPrivateSave={() => {}} onGeneratingChange={() => {}}
      onScheduleChange={value => { schedule = value; }} {...props} />
  </MemoryRouter></SitesRuntimeContext.Provider>));
  await tick(50);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); schedule = undefined;
  vi.useFakeTimers();
  const NativeURL = globalThis.URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = () => 'blob:synthetic-map'; static revokeObjectURL = () => {}; });
  generate = vi.fn(async input => json({ request_id: '00000000-0000-4000-8000-000000000001', backend: 'anthropic', model: 'claude-test', artifact: mapped(input.source) }));
  vi.stubGlobal('fetch', vi.fn(async (path, options) => path === '/api/cloud/map/status'
    ? json({ available: true, personal: true, providers: { openrouter: { enabled: true, model: 'fixture/model', provider: 'Fixture' } } })
    : path === '/api/cloud/map/generate' ? generate(JSON.parse(options.body)) : json({}, 404)));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('live map permission and automatic updates', () => {
  it('assumes permission and starts automatic updates once when every route uses a personal key', async () => {
    await mount(personal);
    expect(permission().checked).toBe(true);
    expect(automatic().checked).toBe(true);
    await tick(1500);
    expect(generateCalls()).toHaveLength(1);
    expect(generate.mock.calls[0][0].routes.map(route => route.backend)).toEqual(['anthropic']);
  });

  it('lets the permission box be unticked, which stops automatic updates for good', async () => {
    generate.mockImplementation(() => new Promise(() => {}));
    await mount(personal);
    await act(async () => permission().click());
    expect(permission().checked).toBe(false);
    expect(automatic().checked).toBe(false);
    expect(automatic().disabled).toBe(true);
    await tick(120_000);
    expect(generateCalls()).toHaveLength(0);
    expect(schedule.state).toBe('needs-consent');
    // Ticking it again is the user's own decision and works as before.
    await act(async () => permission().click());
    expect(permission().checked).toBe(true);
    expect(automatic().checked).toBe(false);
  });

  it('does not assume permission when the chain includes a site-key route', async () => {
    await mount(mixed);
    expect(permission().checked).toBe(false);
    expect(automatic().checked).toBe(false);
    await tick(120_000);
    expect(generateCalls()).toHaveLength(0);
    expect(schedule).toMatchObject({ state: 'needs-consent', maxAttempts: 6, intervalMs: 45_000 });
  });

  it('keeps automatic updates off after one fails, so a failing provider is not retried every interval', async () => {
    generate.mockImplementation(async () => json({ error: 'synthetic refusal' }, 429));
    await mount(personal);
    await tick(1500);
    expect(generateCalls()).toHaveLength(1);
    expect(automatic().checked).toBe(false);
    await act(async () => root.render(<SitesRuntimeContext.Provider value={personal}><MemoryRouter>
      <RecordingConversationMap source={source(' A further stretch of synthetic words arrives after the refusal, long enough to count as new material for another update.')} saving={false} liveActive
        onPrivateSave={() => {}} onGeneratingChange={() => {}} onScheduleChange={value => { schedule = value; }} />
    </MemoryRouter></SitesRuntimeContext.Provider>));
    await tick(180_000);
    expect(generateCalls()).toHaveLength(1);
    expect(automatic().checked).toBe(false);
    // Nothing was mapped, so every word still counts as new for the canvas and for a deliberate retry.
    expect(schedule).toMatchObject({ state: 'error', mappedChars: 0 });
  });

  it('treats a map opened from this device as covering its own transcript', async () => {
    const complete = { ...source(), complete: true };
    const bundle = mapped(complete);
    await mount(personal, { source: complete, savedBundle: bundle, liveActive: false });
    expect(schedule.mappedChars).toBe(bundle.full_transcript.length);
    expect(generateCalls()).toHaveLength(0);
  });

  it('keeps a withdrawn permission when the saved keys are re-read and the same chain arrives as a new object', async () => {
    generate.mockImplementation(() => new Promise(() => {}));
    await mount(personal);
    await act(async () => permission().click());
    const reread = JSON.parse(JSON.stringify(personal));
    await act(async () => root.render(<SitesRuntimeContext.Provider value={reread}><MemoryRouter>
      <RecordingConversationMap source={source()} saving={false} liveActive onPrivateSave={() => {}} onGeneratingChange={() => {}} onScheduleChange={value => { schedule = value; }} />
    </MemoryRouter></SitesRuntimeContext.Provider>));
    await tick(120_000);
    expect(permission().checked).toBe(false);
    expect(automatic().checked).toBe(false);
    expect(generateCalls()).toHaveLength(0);
    expect(fetch.mock.calls.filter(([path]) => path === '/api/cloud/map/status')).toHaveLength(1);
  });

  it('keeps a withdrawn permission for the rest of the recording when the model is changed in Settings', async () => {
    generate.mockImplementation(() => new Promise(() => {}));
    await mount(personal);
    await act(async () => permission().click());
    const changed = { ...personal, preferences: { ...personal.preferences, mapChain: [{ backend: 'anthropic', model: 'claude-other' }] } };
    await act(async () => root.render(<SitesRuntimeContext.Provider value={changed}><MemoryRouter>
      <RecordingConversationMap source={source()} saving={false} liveActive onPrivateSave={() => {}} onGeneratingChange={() => {}} onScheduleChange={value => { schedule = value; }} />
    </MemoryRouter></SitesRuntimeContext.Provider>));
    await tick(120_000);
    expect(permission().checked).toBe(false);
    expect(automatic().checked).toBe(false);
    expect(generateCalls()).toHaveLength(0);
  });
});
