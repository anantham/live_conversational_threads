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
  expect(host.querySelectorAll('button[aria-label*="API reachable"]')).toHaveLength(2);
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
  expect(host.querySelectorAll('button[aria-label*="Needs attention"]')).toHaveLength(2);
});
it('displays disabled and malformed status without claiming readiness', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify(path.includes('soniox') ? { service: 'soniox', enabled: false, reachable: false, checked_at: Date.now() } : { enabled: true })));
  await render(); expect(host.querySelector('button[aria-label*="Switched off"]')).toBeTruthy(); expect(host.querySelector('button[aria-label*="Needs attention"]')).toBeTruthy();
});

it('does not confuse a busy self-held session with provider failure or use server clock for freshness', async () => {
  fetch.mockImplementation(async path => new Response(JSON.stringify({ service: path.split('/').at(-1), enabled: true, available: false, reachable: false, capacity: 'busy', allowance: 'unknown', checked_at: Date.now() - 600000 })));
  await render(); expect(host.querySelectorAll('button[aria-label*="Busy"]')).toHaveLength(2);
  await render({ voice: { service: 'soniox', at: Date.now() - 100, ok: true }, inference: { service: 'openrouter', at: Date.now() - 100, ok: true } });
  expect(host.querySelectorAll('button[aria-label*="Working"]')).toHaveLength(2);
  expect(host.querySelectorAll('button[aria-label*="Needs attention"]')).toHaveLength(0);
});
