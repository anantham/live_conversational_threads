// Test intent: tests/intent/workflow-request-ownership.md
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PromptLibraryPage from './PromptLibraryPage.jsx';
import * as prompts from '../../services/promptsApi';

vi.mock('../../services/promptsApi', () => ({
  getPrompt: vi.fn(),
  getPromptHistory: vi.fn(),
  listPrompts: vi.fn(),
  reloadPrompts: vi.fn(),
  restorePromptVersion: vi.fn(),
  updatePrompt: vi.fn(),
  validatePrompt: vi.fn(),
}));

const config = template => ({ template, description: 'Example prompt', model: 'gpt-4', temperature: 0, max_tokens: 120 });
let root, container;
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent === text);
const click = async text => act(async () => button(text).click());

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.resetAllMocks();
  prompts.listPrompts.mockResolvedValue({ prompts: ['alpha', 'beta'] });
  prompts.getPrompt.mockImplementation(async name => config('Current template for ' + name));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.restoreAllMocks();
});
async function mount() {
  await act(async () => root.render(<MemoryRouter><PromptLibraryPage /></MemoryRouter>));
}
function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

it('ignores late details when a different prompt was selected', async () => {
  const alpha = deferred();
  prompts.getPrompt.mockImplementation(name => name === 'alpha' ? alpha.promise : Promise.resolve(config('Beta template')));
  await mount();
  await click('beta');
  expect(container.textContent).toContain('Beta template');
  await act(async () => alpha.resolve(config('Late alpha template')));
  expect(container.textContent).toContain('Beta template');
  expect(container.textContent).not.toContain('Late alpha template');

  vi.spyOn(window, 'alert').mockImplementation(() => {});
  prompts.validatePrompt.mockResolvedValue({ valid: true });
  prompts.updatePrompt.mockResolvedValue({});
  await click('Edit Prompt');
  expect(container.querySelector('textarea').value).toBe('Beta template');
  await click('Save Changes');
  expect(prompts.updatePrompt).toHaveBeenCalledWith('beta', config('Beta template'), 'user', '');
});

it('hides editing while the selected prompt is loading', async () => {
  const beta = deferred();
  prompts.getPrompt.mockImplementation(name => name === 'beta' ? beta.promise : Promise.resolve(config('Alpha template')));
  await mount();
  expect(button('Edit Prompt')).toBeTruthy();
  await click('beta');
  expect(button('Edit Prompt')).toBeUndefined();
  expect(container.textContent).not.toContain('Alpha template');
  await act(async () => beta.resolve(config('Beta template')));
  expect(button('Edit Prompt')).toBeTruthy();
});

it('ignores version history that arrives after switching prompts', async () => {
  const history = deferred();
  prompts.getPromptHistory.mockReturnValue(history.promise);
  await mount();
  await click('View History');
  await click('beta');
  await act(async () => history.resolve({ history: [{ timestamp: 'synthetic-alpha-version', prompt_config: config('Alpha version') }] }));
  expect(container.textContent).not.toContain('synthetic-alpha-version');
  expect(button('Restore')).toBeUndefined();
});

it('reloads the selected prompt after reloading the files', async () => {
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  prompts.getPrompt.mockResolvedValueOnce(config('Before reload')).mockResolvedValue(config('After reload'));
  prompts.reloadPrompts.mockResolvedValue({});
  await mount();
  expect(container.textContent).toContain('Before reload');
  await click('Reload from File');
  expect(container.textContent).toContain('After reload');
  expect(prompts.getPrompt.mock.calls.map(([name]) => name)).toEqual(['alpha', 'alpha']);
});
