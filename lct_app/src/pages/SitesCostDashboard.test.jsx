// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SitesCostDashboard from './SitesCostDashboard';
import { recordSitesCostEntry } from '../services/cloud/sitesCostStore';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ available: true, personal: true, providers: {} })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('renders Sites usage stats without calling the Python backend and clears local logs', async () => {
  recordSitesCostEntry({
    provider: 'anthropic',
    model: 'claude-sonnet-5-live',
    usage: { input_tokens: 12000, output_tokens: 3000, total_tokens: 15000 },
  });
  recordSitesCostEntry({
    provider: 'openrouter',
    model: 'google/gemini-3-pro',
    usage: { input_tokens: 5000, output_tokens: 1000, total_tokens: 6000, cost_usd: 0.042 },
  });

  await act(async () => root.render(<MemoryRouter><SitesCostDashboard /></MemoryRouter>));
  expect(container.textContent).toContain('Costs');
  expect(container.textContent).toContain('21,000');
  expect(container.textContent).toContain('$0.042');
  expect(container.textContent).toContain('Anthropic · claude-sonnet-5-live');
  expect(container.textContent).toContain('OpenRouter · google/gemini-3-pro');
  expect(container.textContent).not.toContain('Error Loading Cost Data');
  expect(fetch).toHaveBeenCalledWith('/api/cloud/map/status', expect.anything());

  const clearBtn = [...container.querySelectorAll('button')].find(el => el.textContent.includes('Clear browser log'));
  await act(async () => clearBtn.click());
  expect(container.textContent).toContain('No generation calls recorded');
});
