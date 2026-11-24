// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SitesProviderSettings from '../../components/settings/SitesProviderSettings';
import SitesMapPrompts from '../../components/settings/SitesMapPrompts';
import SitesRuntimeProvider from '../../contexts/SitesRuntimeProvider';
import { readProviderPreferences } from '../../services/cloud/sitesProviderPreferences';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(start = '/providers') {
  await act(async () => root.render(<SitesRuntimeProvider>
    <MemoryRouter initialEntries={[start]}>
      <Link to="/providers">Providers</Link><Link to="/prompts">Prompts</Link>
      <Routes><Route path="/providers" element={<SitesProviderSettings />} /><Route path="/prompts" element={<SitesMapPrompts />} /></Routes>
    </MemoryRouter>
  </SitesRuntimeProvider>));
}
const button = label => [...container.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') || el.textContent) === label);
const click = async element => act(async () => element.click());
function field(label) {
  return [...container.querySelectorAll('label')].find(el => el.textContent.trim().startsWith(label))?.querySelector('input,textarea,select');
}
async function type(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select, value) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('manages provider keys separately and allows multiple ordered models from the same provider', async () => {
  await mount();
  const input = field('Anthropic API key');
  await type(input, 'synthetic-tab-key');
  const row = input.closest('li');
  const saveKey = [...row.querySelectorAll('button')].find(el => el.textContent === 'Use for this session');
  await click(saveKey);
  expect(container.textContent).toContain('Key saved for this tab.');
  expect(input.value).toBe('');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-tab-key');

  // Build OpenRouter (model A) -> Anthropic (model B) -> OpenRouter (model C)
  await choose(container.querySelector('select[aria-label="First choice model"]'), 'anthropic/claude-sonnet-4.5');
  await click(button('+ Add model'));
  await choose(container.querySelector('select[aria-label="Fallback 1 provider"]'), 'anthropic');
  await choose(container.querySelector('select[aria-label="Fallback 1 model"]'), 'claude-sonnet-4-5-20250929');
  await click(button('+ Add model'));
  await choose(container.querySelector('select[aria-label="Fallback 2 provider"]'), 'openrouter');
  await choose(container.querySelector('select[aria-label="Fallback 2 model"]'), 'google/gemini-2.5-pro');

  expect(readProviderPreferences().mapChain).toEqual([
    { backend: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
    { backend: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { backend: 'openrouter', model: 'google/gemini-2.5-pro' },
  ]);

  await click(button('Move Fallback 1 up'));
  expect(readProviderPreferences().mapChain[0]).toEqual({ backend: 'anthropic', model: 'claude-sonnet-4-5-20250929' });

  await click(container.querySelector('a[href="/prompts"]'));
  await click(container.querySelector('a[href="/providers"]'));
  expect(container.textContent).toContain('Personal key set for this tab');
  await click(button('Remove key'));
  expect(container.textContent).toContain('Personal key removed.');
  expect(fetch).not.toHaveBeenCalled();
});

it('loads live models into the provider dropdown when testing a personal key', async () => {
  fetch.mockResolvedValueOnce(Response.json({
    message: 'Provider access confirmed. Loaded 1 models. Usage and billing were not tested.',
    models: [{ id: 'claude-sonnet-5-5-live', label: 'Claude Sonnet 5.5 Live' }],
  }));
  await mount();
  const input = field('Anthropic API key');
  await type(input, 'synthetic-live-key');
  const row = input.closest('li');
  await click([...row.querySelectorAll('button')].find(el => el.textContent === 'Use for this session'));
  await click([...row.querySelectorAll('button')].find(el => el.textContent === 'Test connection & load models'));
  expect(container.textContent).toContain('Loaded 1 models');
  await choose(container.querySelector('select[aria-label="First choice provider"]'), 'anthropic');
  const options = [...container.querySelector('select[aria-label="First choice model"]').options].map(o => o.value);
  expect(options).toContain('claude-sonnet-5-5-live');
});

it('edits and restores the map prompt without contacting the legacy prompt service', async () => {
  await mount('/prompts');
  expect(container.textContent).toContain('Conversation map prompt');
  await type(field('Additional guidance'), 'Trace changes of mind.');
  await click(button('Save guidance'));
  expect(readProviderPreferences().guidance).toBe('Trace changes of mind.');
  await click(button('Restore default'));
  expect(readProviderPreferences().guidance).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
