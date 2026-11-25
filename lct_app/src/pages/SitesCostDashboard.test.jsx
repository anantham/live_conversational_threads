// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SitesCostDashboard from './SitesCostDashboard';
import { recordSitesCostEntry } from '../services/cloud/sitesCostStore';
import { recordQualitySnapshot } from '../services/cloud/qualityLedgerStore';

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

it('renders Sites usage, latency, first-token, and reliability stats without calling the Python backend', async () => {
  recordSitesCostEntry({
    provider: 'anthropic',
    model: 'claude-sonnet-5-live',
    kind: 'skeleton',
    ttftMs: 12400,
    durationMs: 32400,
    nodes: 19,
    coveragePct: 100,
    usage: { input_tokens: 12000, output_tokens: 3000, total_tokens: 15000 },
  });
  recordSitesCostEntry({
    provider: 'openrouter',
    model: 'google/gemini-3-pro',
    kind: 'detail',
    ttftMs: 2100,
    durationMs: 8100,
    usage: { input_tokens: 5000, output_tokens: 1000, total_tokens: 6000, cost_usd: 0.042 },
  });
  recordSitesCostEntry({
    provider: 'anthropic',
    model: 'claude-sonnet-5-live',
    kind: 'detail',
    durationMs: 4000,
    outcome: 'error',
    errorCode: 'max_tokens',
  });
  recordQualitySnapshot({
    conversation_id: 'call-1',
    conversation_title: 'Synthetic Quality Call',
    graph_data: [{ id: '1' }, { id: '2' }],
    audit_signals: [
      { id: 'a1', source: 'audit', kind: 'represented', decision: 'not_needed' },
      { id: 'u1', source: 'user', kind: 'misfiled', decision: 'accepted' },
    ],
    boundary_corrections: [{ id: 'bc-1', kind: 'merge' }],
  });

  await act(async () => root.render(<MemoryRouter><SitesCostDashboard /></MemoryRouter>));
  expect(container.textContent).toContain('Costs & Observability');
  expect(container.textContent).toContain('Map quality & audit ledger');
  expect(container.textContent).toContain('Synthetic Quality Call');
  expect(container.textContent).toContain('100% audit recall');
  expect(container.textContent).toContain('21,000');
  expect(container.textContent).toContain('$0.042');
  expect(container.textContent).toContain('67% ok · 1 failed');
  expect(container.textContent).toContain('100% cov');
  expect(container.textContent).toContain('max_tokens');
  expect(container.textContent).toContain('Anthropic · claude-sonnet-5-live');
  expect(container.textContent).toContain('OpenRouter · google/gemini-3-pro');
  expect(container.textContent).not.toContain('Error Loading Cost Data');
  expect(fetch).toHaveBeenCalledWith('/api/cloud/map/status', expect.anything());

  const clearBtn = [...container.querySelectorAll('button')].find(el => el.textContent.includes('Clear browser log'));
  await act(async () => clearBtn.click());
  expect(container.textContent).toContain('No generation calls recorded');
});
