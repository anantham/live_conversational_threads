// Intent: tests/intent/sites-conversation-controls.md. UI only; no network or capture.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import ConversationNavigation from './ConversationNavigation.jsx';
let root, host;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });
it('keeps destinations in More, retains icon names, dismisses with Escape and opens the selected tools', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const panel = vi.fn();
  await act(async () => root.render(<MemoryRouter><ConversationNavigation panel={null} onPanelChange={panel} /></MemoryRouter>));
  const more = host.querySelector('[aria-label="More options"]');
  expect(host.textContent).not.toContain('Public conversations');
  expect(host.querySelector('a').textContent).toBe('');
  expect(host.querySelector('a').getAttribute('href')).toBe('/');
  await act(async () => host.querySelector('[aria-label="AI map"]').click()); expect(panel).toHaveBeenCalledWith('map');
  await act(async () => more.click());
  expect(document.activeElement.getAttribute('href')).toBe('/meeting');
  expect(host.querySelector('a[href="/private-files"]')).toBeTruthy();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.textContent).not.toContain('Public conversations'); expect(document.activeElement).toBe(more);
  await act(async () => more.click());
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Files & export').click());
  expect(panel).toHaveBeenLastCalledWith('files'); expect(more.getAttribute('aria-expanded')).toBe('false');
  await act(async () => more.click());
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(more.getAttribute('aria-expanded')).toBe('false');
});

it('shows map progress and failure on the map button, with an announcement only for failure', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = props => act(async () => root.render(<MemoryRouter><ConversationNavigation panel={null} onPanelChange={() => {}} {...props} /></MemoryRouter>));
  const mapButton = () => host.querySelector('[aria-label^="AI map"]');
  const announcement = () => host.querySelector('[role="status"]').textContent;
  await render({});
  expect(mapButton().getAttribute('aria-label')).toBe('AI map'); expect(mapButton().querySelector('span')).toBeNull(); expect(announcement()).toBe('');
  await render({ mapError: 'The provider refused the request.' });
  expect(mapButton().getAttribute('aria-label')).toBe('AI map · Needs attention');
  expect(mapButton().querySelector('span').className).toContain('bg-rose-600');
  expect(announcement()).toContain('needs attention');
  // A new attempt is shown as updating even before the old error is cleared.
  await render({ mapError: 'The provider refused the request.', mapUpdating: true });
  expect(mapButton().getAttribute('aria-label')).toBe('AI map · Updating'); expect(announcement()).toBe('');
});
