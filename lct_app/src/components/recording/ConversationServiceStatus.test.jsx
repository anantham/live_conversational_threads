// Intent: tests/intent/sites-conversation-controls.md. Synthetic health; no providers.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConversationServiceStatus from './ConversationServiceStatus.jsx';
let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async path => new Response(JSON.stringify({ service: path.split('/').at(-1), enabled: true, reachable: true, available: true, allowance: 'unknown', checked_at: Date.now(), latency_ms: 123, detail: 'API responded.' })))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = async (props = {}) => act(async () => root.render(<ConversationServiceStatus backend="openrouter" onRefresh={() => {}} {...props} />));
it('shows uncertain readiness, latency on focus, and only actual operation evidence as green', async () => {
  await render();
  expect(host.querySelectorAll('button[aria-label*="Available"]')).toHaveLength(2);
  await act(async () => host.querySelector('button').focus());
  expect(host.textContent).toContain('API check: 123 ms'); expect(host.textContent).toContain('Credit balance unavailable');
  await render({ voice: { service: 'soniox', at: Date.now() + 1, ok: true }, inference: { service: 'openrouter', at: Date.now() + 1, ok: true } });
  expect(host.querySelectorAll('button[aria-label*="Working"]')).toHaveLength(2);
  await render({ backend: 'gemini', inference: { service: 'openrouter', at: Date.now() + 1, ok: true } });
  expect(host.querySelectorAll('button[aria-label*="Working"]')).toHaveLength(0);
  expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
});
it('bounds an uncooperative fetch and never turns unknown status green', async () => {
  vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {})); await render();
  await act(async () => vi.advanceTimersByTimeAsync(8001));
  expect(host.querySelectorAll('button[aria-label*="Not reachable"]')).toHaveLength(2);
});
it('displays disabled and malformed status without claiming readiness', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify(path.includes('soniox') ? { service: 'soniox', enabled: false, reachable: false, checked_at: Date.now() } : { enabled: true })));
  await render(); expect(host.querySelector('button[aria-label*="Switched off"]')).toBeTruthy(); expect(host.querySelector('button[aria-label*="Not reachable"]')).toBeTruthy();
});

it('does not confuse a busy self-held session with provider failure or use server clock for freshness', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify({ service: path.split('/').at(-1), enabled: true, available: false, reachable: false, capacity: 'busy', allowance: 'unknown', checked_at: Date.now() - 600000 })));
  await render(); expect(host.querySelectorAll('button[aria-label*="Busy"]')).toHaveLength(2);
  await render({ voice: { service: 'soniox', at: Date.now() - 100, ok: true }, inference: { service: 'openrouter', at: Date.now() - 100, ok: true } });
  expect(host.querySelectorAll('button[aria-label*="Working"]')).toHaveLength(2);
  expect(host.querySelectorAll('button[aria-label*="Not reachable"]')).toHaveLength(0);
});

it.each([
  ['available', 'Account balance checked: credit available.'],
  ['exhausted', 'Account balance checked: no credit remains.'],
  ['permission_required', 'Account balance check refused. OpenRouter requires management-key access.'],
  ['unavailable', 'Account balance check could not finish.'],
])('shows the actual same-check account result for %s', async (balance, copy) => {
  fetch.mockImplementation(async path => new Response(JSON.stringify({ service: path.split('/').at(-1), enabled: true, reachable: true, available: true,
    allowance: balance === 'exhausted' ? 'exhausted' : 'key_available', account_balance: balance, checked_at: Date.now() })));
  await render(); await act(async () => host.querySelector('button[aria-label^="Map making"]').focus());
  expect(host.textContent).toContain(copy);
  expect(host.textContent).not.toContain('Account credit balance unknown');
  expect(host.querySelector('button[aria-label*="Working"]')).toBeNull();
  if (balance === 'exhausted') expect(host.querySelector('button[aria-label^="Map making: Not available right now"]')).toBeTruthy();
});

// The live Site's own responses on 2026-11-05: the Soniox key may not list models, and map making was at its shared limit.
const live = { soniox: { service: 'soniox', enabled: true, available: true, reachable: false, allowance: 'unknown', probe: 'model_listing', access: 'permission_denied', detail: 'This key cannot list Soniox models. Transcription permissions have not been checked.', latency_ms: 595 },
  openrouter: { service: 'openrouter', enabled: true, available: false, reachable: false, allowance: 'unknown', capacity: 'exhausted', detail: 'The shared attempt limit has been reached.' } };
const popover = service => host.querySelector(`#status-${service}`);
const shown = service => [...popover(service).children].filter(node => node.tagName === 'P').map(node => node.textContent).join(' ');

it('tells a visitor what they can do and keeps the provider check under Details', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify({ ...live[path.split('/').at(-1)], checked_at: Date.now() })));
  await render();
  const voice = host.querySelector('button[aria-label^="Live transcription"]'), map = host.querySelector('button[aria-label^="Map making"]');
  expect(voice.getAttribute('aria-label')).toBe('Live transcription: Available');
  expect(voice.querySelector('span').className).not.toContain('rose');
  expect(map.getAttribute('aria-label')).toBe('Map making: Not available right now');
  expect(map.querySelector('span').className).not.toContain('rose');
  await act(async () => voice.focus());
  expect(shown('soniox')).toContain('Live transcription is ready');
  expect(shown('soniox')).not.toContain('Soniox models');
  expect(popover('soniox').querySelector('details').textContent).toContain('This key cannot list Soniox models');
  await act(async () => map.focus());
  expect(shown('openrouter')).toContain('Map making has reached its shared limit. Recording and the transcript still work.');
  expect(shown('openrouter')).not.toContain('attempt limit');
});

it('still reports a key that fails authentication as not reachable', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify(path.includes('soniox') ? { ...live.soniox, access: 'unauthenticated', checked_at: Date.now() } : { ...live.openrouter, checked_at: Date.now() })));
  await render();
  expect(host.querySelector('button[aria-label^="Live transcription"]').getAttribute('aria-label')).toBe('Live transcription: Not reachable');
  expect(host.querySelector('button[aria-label^="Live transcription"] span').className).toContain('rose');
});

it('keeps a live transcript green across a refresh that only says the key cannot list models', async () => {
  vi.useFakeTimers();
  fetch.mockImplementation(async path => new Response(JSON.stringify({ ...live[path.split('/').at(-1)], checked_at: Date.now() })));
  await render({ voice: { service: 'soniox', at: Date.now() + 1, ok: true, detail: 'Transcript is receiving words from Soniox.' } });
  expect(host.querySelector('button[aria-label^="Live transcription"]').getAttribute('aria-label')).toBe('Live transcription: Working');
  await act(async () => vi.advanceTimersByTimeAsync(60_000)); // the background refresh lands after the evidence
  expect(host.querySelector('button[aria-label^="Live transcription"]').getAttribute('aria-label')).toBe('Live transcription: Working');
});
