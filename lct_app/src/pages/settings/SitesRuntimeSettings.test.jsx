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
  return [...container.querySelectorAll('label')].find(el => el.textContent.trim() === label)?.querySelector('input,textarea');
}
async function type(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('reorders providers and keeps a personal key in memory across Settings pages', async () => {
  await mount();
  await click([...container.querySelectorAll('label')].find(el => el.textContent.startsWith('Anthropic') && el.querySelector('input[type=checkbox]')).querySelector('input'));
  await click(button('Move Anthropic up'));
  expect(readProviderPreferences().map).toEqual(['anthropic', 'openrouter']);
  const input = field('Anthropic API key');
  await type(input, 'synthetic-tab-key');
  const row = input.closest('li');
  const saveKey = [...row.querySelectorAll('button')].find(el => el.textContent === 'Use for this session');
  await click(saveKey);
  expect(container.textContent).toContain('Key saved for this tab.');
  expect(input.value).toBe('');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-tab-key');
  await click(container.querySelector('a[href="/prompts"]'));
  await click(container.querySelector('a[href="/providers"]'));
  expect(container.textContent).toContain('Personal key set for this tab');
  await click(button('Remove key'));
  expect(container.textContent).toContain('Personal key removed.');
  expect(fetch).not.toHaveBeenCalled();
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
