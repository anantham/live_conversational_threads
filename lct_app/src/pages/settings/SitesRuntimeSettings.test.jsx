// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SitesProviderSettings from '../../components/settings/SitesProviderSettings';
import SitesMapPrompts from '../../components/settings/SitesMapPrompts';
import SitesRuntimeProvider from '../../contexts/SitesRuntimeProvider';
import { readProviderPreferences } from '../../services/cloud/sitesProviderPreferences';

const saved = vi.hoisted(() => ({ entries: {}, sequence: 0 }));
vi.mock('../../services/cloud/sitesProviderCredentialStore', () => ({
  async readSavedProviderCredentials() { return { entries: { ...saved.entries }, unreadable: false }; },
  async writeSavedProviderKey(id, key) { saved.entries[id] = { key, revision: String(++saved.sequence), models: [], modelsFetchedAt: 0 }; },
  async deleteSavedProviderKey(id) { delete saved.entries[id]; },
  async writeSavedProviderModels(id, revision, models) {
    if (saved.entries[id]?.revision !== revision) return false;
    saved.entries[id] = { ...saved.entries[id], models, modelsFetchedAt: Date.now() };
    return true;
  },
}));

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  saved.entries = {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

async function saveKey(provider, key) {
  const input = field(provider + ' API key');
  await type(input, key);
  const row = input.closest('li');
  await click([...row.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === 'Save key'));
  expect(input.value).toBe('');
  return row;
}

const providerResponse = (...ids) => Response.json({
  message: `Loaded ${ids.length} models.`, models: ids.map(id => ({ id, label: id })),
});
const modelSelect = rank => container.querySelector(`select[aria-label="${rank} model"]`);
const providerSelect = rank => container.querySelector(`select[aria-label="${rank} provider"]`);
const options = select => [...select.options].map(option => option.value);

it('loads live models on save and restores keys, catalogs and fallback order after remount', async () => {
  fetch.mockResolvedValueOnce(providerResponse('google/gemini-test', 'anthropic/claude-test'));
  fetch.mockResolvedValueOnce(providerResponse('claude-sonnet-5-5'));
  await mount();
  await saveKey('OpenRouter', 'synthetic-router-key');
  await saveKey('Anthropic', 'synthetic-claude-key');
  expect(fetch).toHaveBeenCalledTimes(2);

  await choose(modelSelect('First choice'), 'anthropic/claude-test');
  await click(button('+ Add model'));
  await choose(providerSelect('Fallback 1'), 'anthropic');
  expect(options(modelSelect('Fallback 1'))).toEqual(['', 'claude-sonnet-5-5', '__custom__']);
  await click(button('Move Fallback 1 up'));

  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  expect(container.textContent).toContain('Personal key saved in this browser');
  expect(modelSelect('First choice').value).toBe('claude-sonnet-5-5');
  expect(options(modelSelect('First choice'))).toEqual(['', 'claude-sonnet-5-5', '__custom__']);
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-claude-key');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('refreshes the catalog without silently changing a saved model and removes the cached list with its key', async () => {
  fetch.mockResolvedValueOnce(providerResponse('claude-sonnet-5'));
  fetch.mockResolvedValueOnce(providerResponse('claude-sonnet-5-5'));
  await mount();
  const row = await saveKey('Anthropic', 'synthetic-claude-key');
  await choose(providerSelect('First choice'), 'anthropic');
  expect(modelSelect('First choice').value).toBe('claude-sonnet-5');
  await click([...row.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === 'Refresh models'));
  expect(options(modelSelect('First choice'))).toEqual(['', 'claude-sonnet-5', 'claude-sonnet-5-5', '__custom__']);
  expect(modelSelect('First choice').selectedOptions[0].textContent).toContain('saved ID');
  await click(button('Remove key'));
  expect(container.textContent).toContain('Personal key and cached models removed.');
  expect(options(modelSelect('First choice'))).toEqual(['', 'claude-sonnet-5', '__custom__']);
});

it('refreshes an expired saved catalog in the background and retains it if the provider refuses', async () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 10, 25);
  vi.setSystemTime(now);
  saved.entries.anthropic = { key: 'synthetic-claude-key', revision: 'existing', modelsFetchedAt: now - 23 * 60 * 60 * 1000,
    models: [{ id: 'claude-test-cached', label: 'Claude cached' }] };
  await mount();
  await choose(providerSelect('First choice'), 'anthropic');
  expect(fetch).not.toHaveBeenCalled();
  expect(modelSelect('First choice').value).toBe('claude-test-cached');
  expect(button('Test Claude map schema')).toBeUndefined();
  expect(button('Compare both schemas')).toBeUndefined();
  expect(button('Remove key').textContent).toBe('');

  fetch.mockResolvedValueOnce(Response.json({ error: 'Model service unavailable.' }, { status: 502 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(options(modelSelect('First choice'))).toContain('claude-test-cached');
  expect(container.textContent).toContain('Model service unavailable.');

  fetch.mockResolvedValueOnce(providerResponse('claude-test-new'));
  await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(options(modelSelect('First choice'))).toContain('claude-test-new');
  expect(saved.entries.anthropic.modelsFetchedAt).toBe(now + 75 * 60 * 1000);
});

it('shows published Claude token rates alongside model names while saving the same model IDs', async () => {
  fetch.mockResolvedValueOnce(Response.json({ models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-unlisted', label: 'Unlisted Claude' },
  ] }));
  await mount();
  await saveKey('Anthropic', 'synthetic-claude-key');
  await choose(providerSelect('First choice'), 'anthropic');
  const select = modelSelect('First choice');
  expect([...select.options].map(option => option.textContent)).toEqual([
    'Site default',
    'Claude Opus 5.5 · $4 in / $20 out',
    'Claude Haiku 5.5 · $0.10–$0.50 in / $0.50–$2.50 out',
    'Claude Haiku 4.5 · $1 in / $5 out',
    'Unlisted Claude (claude-unlisted)',
    'Custom model ID…',
  ]);
  expect(container.textContent).toContain('USD per million tokens');
  await choose(select, 'claude-haiku-4-5-20251001');
  expect(readProviderPreferences().mapChain[0].model).toBe('claude-haiku-4-5-20251001');
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

it('refuses an M5 endpoint on another tailnet out loud and saves one on the owner tailnet', async () => {
  localStorage.setItem('lct.sites.provider-preferences.v1', JSON.stringify({ speech: ['m5_tailnet', 'soniox'] }));
  await mount();
  const input = field('Tailnet endpoint');
  expect(input).not.toBeUndefined();
  const blur = async () => act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

  await type(input, 'https://attacker-box.tailEVIL.ts.net/v1/audio/transcriptions');
  await blur();
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Not saved/);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(readProviderPreferences().m5TailnetUrl).toBe('');

  const own = 'https://other-host.tail4741ad.ts.net:5443/v1/audio/transcriptions';
  await type(input, ` ${own} `);
  await blur();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(readProviderPreferences().m5TailnetUrl).toBe(own);
});
