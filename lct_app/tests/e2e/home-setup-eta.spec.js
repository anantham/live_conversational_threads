import { expect, test } from '@playwright/test';

/**
 * Test Intent
 * - Show a visible countdown while the real settings + provider-probe lifecycle is pending.
 * - Persist the completed cycle and cite that empirical sample on the next page load.
 * - Keep the mobile status shelf inside the viewport while the ETA copy is visible.
 */

const SETUP_STAGE_DELAY_MS = 1100;

async function delayedJson(route, payload, delayMs = SETUP_STAGE_DELAY_MS) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    body: JSON.stringify(payload),
    contentType: 'application/json',
    status: 200,
  });
}

async function mockHealthySetup(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/api/import/health') {
      await delayedJson(route, { status: 'ok' }, 0);
      return;
    }
    if (pathname === '/api/settings/llm/providers/health') {
      await delayedJson(route, { healthy: true, latency_ms: 12, url: 'http://llm.test' });
      return;
    }
    if (pathname === '/api/settings/stt/health-check') {
      await delayedJson(route, {
        ok: true,
        health_url: 'http://stt.test/health',
        latency_ms: 10,
        response_preview: {
          status: 'healthy',
          engine: 'fluidaudio-parakeet',
          model: 'parakeet-tdt-0.6b-v3',
          diarization: 'ready',
        },
      });
      return;
    }
    if (pathname === '/api/settings/llm/providers') {
      await delayedJson(route, {
        providers: [{
          id: 'test-llm',
          name: 'Test LLM',
          enabled: true,
          type: 'openai_compatible',
          base_url: 'http://llm.test',
          model: 'test-model',
        }],
      });
      return;
    }
    if (pathname === '/api/settings/llm') {
      await delayedJson(route, {
        mode: 'local',
        base_url: 'http://llm.test',
        chat_model: 'test-model',
      });
      return;
    }
    if (pathname === '/api/settings/stt') {
      await delayedJson(route, {
        provider: 'parakeet',
        local_only: true,
        provider_http_urls: {
          parakeet: 'http://stt.test/v1/audio/transcriptions',
        },
      });
      return;
    }
    if (pathname === '/api/backend-catalog') {
      await delayedJson(route, {
        active: {},
        stt: [],
        llm: [],
        diarization: [],
      });
      return;
    }

    await route.abort();
  });
}

test('home setup ETA learns from a completed check and stays mobile-safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHealthySetup(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.getByText('Checking live setup…')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/about \d+s remaining/).first()).toBeVisible();
  await expect(page.getByText(/Initial estimate · this browser learns/).first()).toBeVisible();

  const etaBounds = await page.getByText('Checking live setup…').locator('..').evaluate((element) => {
    const rect = element.parentElement.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
  });
  expect(etaBounds.left).toBeGreaterThanOrEqual(0);
  expect(etaBounds.right).toBeLessThanOrEqual(etaBounds.viewportWidth);

  await expect(page.getByText('Checking live setup…')).toBeHidden({ timeout: 10000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Checking live setup…')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/Based on 1 recent check · usually about \d+s/).first()).toBeVisible();
});
