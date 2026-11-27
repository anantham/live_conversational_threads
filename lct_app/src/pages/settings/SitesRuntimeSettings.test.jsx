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
  expect(container.textContent).toContain('Anthropic · Personal key saved · 1 model');
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

it('tests the M5 Tailnet STT endpoint from the providers screen', async () => {
  fetch.mockResolvedValueOnce(Response.json({
    engine: 'fluidaudio-parakeet',
    model: 'parakeet-tdt-0.6b-v3',
    diarization: 'ready',
    status: 'healthy',
  }));
  await mount();
  const checkbox = [...container.querySelectorAll('label')]
    .find(el => el.textContent.includes('M5 Tailnet STT'))
    ?.querySelector('input[type="checkbox"]');
  await click(checkbox);
  await click(button('Test endpoint'));
  expect(fetch).toHaveBeenCalledWith(
    'https://adityas-macbook-pro.tail4741ad.ts.net:5443/health',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(container.textContent).toContain('fluidaudio-parakeet');
  expect(container.textContent).toContain('diarization: ready');
});

it('reorders Speech-to-text and Intelligence fallback chains via drag-and-drop', async () => {
  await mount();
  const m5Checkbox = [...container.querySelectorAll('label')]
    .find(el => el.textContent.includes('M5 Tailnet STT'))
    ?.querySelector('input[type="checkbox"]');
  await click(m5Checkbox);
  expect(readProviderPreferences().speech).toEqual(['soniox', 'm5_tailnet']);

  const speechRows = [...container.querySelectorAll('#speech-to-text ol > li')];
  await act(async () => {
    speechRows[1].dispatchEvent(new Event('dragstart', { bubbles: true }));
    speechRows[0].dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    speechRows[0].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    speechRows[1].dispatchEvent(new Event('dragend', { bubbles: true }));
  });
  expect(readProviderPreferences().speech).toEqual(['m5_tailnet', 'soniox']);

  await click(button('+ Add model'));
  await choose(providerSelect('Fallback 1'), 'anthropic');
  expect(readProviderPreferences().mapChain.map(r => r.backend)).toEqual(['openrouter', 'anthropic']);

  const mapRows = [...container.querySelectorAll('#intelligence ol > li')];
  await act(async () => {
    mapRows[1].dispatchEvent(new Event('dragstart', { bubbles: true }));
    mapRows[0].dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    mapRows[0].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    mapRows[1].dispatchEvent(new Event('dragend', { bubbles: true }));
  });
  expect(readProviderPreferences().mapChain.map(r => r.backend)).toEqual(['anthropic', 'openrouter']);
});

// Test intent (provider key rows):
// - At rest each provider is one line: its name, whether a personal key is saved and how many models it loaded.
//   The key form stays hidden until asked for, and hides again after a save.
// - Test checks the saved key through the existing no-spend provider check, reports the provider's answer and
//   the measured round trip, and never offers itself where there is no saved key to check.
const keyRow = name => [...container.querySelectorAll('#intelligence li')].find(row => row.textContent.includes(name));
const seedKey = (id, models = []) => { saved.entries[id] = { key: `synthetic-${id}-key`, revision: 'existing', models, modelsFetchedAt: Date.now() }; };

it('shows each provider as one summary line and keeps the key form closed until asked for', async () => {
  seedKey('anthropic', [{ id: 'claude-a', label: 'Claude A' }, { id: 'claude-b', label: 'Claude B' }]);
  await mount();
  const row = keyRow('Anthropic');
  expect(row.textContent).toContain('Anthropic · Personal key saved · 2 models');
  const form = row.querySelector('form');
  expect(form.hidden).toBe(true);
  const edit = button('Edit Anthropic key');
  expect(edit.getAttribute('aria-expanded')).toBe('false'); expect(edit.getAttribute('aria-controls')).toBe(form.id);
  await click(edit);
  expect(form.hidden).toBe(false);
  expect(button('Done editing Anthropic key').getAttribute('aria-expanded')).toBe('true');
  await click(button('Done editing Anthropic key'));
  expect(form.hidden).toBe(true);

  const gemini = keyRow('Gemini');
  expect(gemini.textContent).toContain('Site configuration');
  expect(gemini.textContent).not.toContain('Personal key saved');
  expect(gemini.querySelector('form').hidden).toBe(true);
  expect(button('Add Gemini key')).toBeTruthy();
  expect(button('Test Gemini key')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('closes the key form after a save and reports the save beside the summary', async () => {
  fetch.mockResolvedValueOnce(providerResponse('claude-sonnet-5'));
  await mount();
  await click(button('Add Anthropic key'));
  const row = await saveKey('Anthropic', 'synthetic-claude-key');
  expect(row.querySelector('form').hidden).toBe(true);
  expect(row.textContent).toContain('Key saved in this browser.');
  expect(row.textContent).toContain('Anthropic · Personal key saved · 1 model');
});

it('tests a saved key against its provider and reports the answer with the measured round trip', async () => {
  seedKey('anthropic', [{ id: 'claude-a', label: 'Claude A' }]);
  let respond;
  fetch.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
  await mount();
  await click(button('Test Anthropic key'));
  expect(button('Test Anthropic key').disabled).toBe(true);
  expect(button('Test Anthropic key').textContent).toBe('Testing…');
  const [path, init] = fetch.mock.calls[0];
  expect(path).toBe('/api/cloud/providers/check');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ backend: 'anthropic', key: 'synthetic-anthropic-key' });
  await act(async () => respond(Response.json({ message: 'Provider access confirmed. Loaded 2 models. Usage and billing were not tested.',
    models: [{ id: 'claude-a', label: 'Claude A' }, { id: 'claude-c', label: 'Claude C' }] })));
  const row = keyRow('Anthropic');
  const result = [...row.querySelectorAll('[role=status]')].find(el => el.textContent.includes('Provider access confirmed'));
  expect(result.textContent).toMatch(/Usage and billing were not tested\. Round trip \d+(\.\d)? (ms|s), through this site\./);
  expect(result.className).toContain('emerald');
  expect(row.textContent).toContain('Personal key saved · 2 models');
  expect(button('Test Anthropic key').disabled).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('shows the provider’s refusal when a saved key fails its test, and drops the result once the key is replaced', async () => {
  seedKey('openrouter');
  fetch.mockResolvedValueOnce(Response.json({ error: 'The provider’s model check returned HTTP 401. Check the key and its permissions.' }, { status: 502 }));
  await mount();
  await click(button('Test OpenRouter key'));
  const row = keyRow('OpenRouter');
  const failed = [...row.querySelectorAll('[role=status]')].find(el => el.textContent.includes('HTTP 401'));
  expect(failed.className).toContain('rose');
  expect(failed.textContent).toContain('Round trip');
  expect(row.textContent).toContain('OpenRouter · Personal key saved');
  fetch.mockResolvedValueOnce(providerResponse('openrouter/model-a'));
  await saveKey('OpenRouter', 'synthetic-replacement-key');
  expect(row.textContent).not.toContain('HTTP 401');
});

it('offers Test for a saved speech key but leaves the M5 endpoint to its own reachability test', async () => {
  seedKey('soniox'); seedKey('m5_tailnet');
  localStorage.setItem('lct.sites.provider-preferences.v1', JSON.stringify({ ...readProviderPreferences(), speech: ['soniox', 'm5_tailnet'] }));
  await mount();
  expect(button('Test Soniox key')).toBeTruthy();
  expect(button('Test M5 Tailnet STT key')).toBeUndefined();
  expect(button('Test endpoint')).toBeTruthy();
});
