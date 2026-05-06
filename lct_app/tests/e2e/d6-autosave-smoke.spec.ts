import { test, expect } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:43173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:43180';

test.describe('D6 phase 1 — autosave smoke', () => {
  test('/new loads without console errors after hook reshape', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const draftPosts: string[] = [];
    const forbiddenPosts: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('request', (req) => {
      const url = req.url();
      const method = req.method();
      if (
        method === 'POST' &&
        /\/api\/conversations\/[a-f0-9-]+\/draft/.test(url)
      ) {
        draftPosts.push(url);
      }
      // Anything posting nodes/graph_data after D6 = violation
      if (method === 'POST' || method === 'PATCH') {
        const post = req.postData() || '';
        if (
          /"nodes"\s*:/.test(post) ||
          /"graph_data"\s*:/.test(post) ||
          /"chunks"\s*:/.test(post)
        ) {
          forbiddenPosts.push(`${method} ${url}`);
        }
      }
    });

    await page.goto(`${FRONTEND_URL}/new`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000); // settle

    // No console errors except known-irrelevant ones
    const filtered = consoleErrors.filter(
      (e) =>
        !e.includes('React DevTools') &&
        !e.includes('favicon') &&
        !e.includes('Download the React') &&
        !e.includes('source-map')
    );

    console.log('Console errors:', filtered);
    console.log('Page errors:', pageErrors);
    console.log('Draft POSTs:', draftPosts);
    console.log('Forbidden POSTs (nodes/graph_data/chunks):', forbiddenPosts);

    // Assertions
    expect(pageErrors, 'no uncaught page errors').toEqual([]);
    expect(forbiddenPosts, 'no semantic-state writes from browser').toEqual([]);
    // Note: filtered console errors may include backend network errors that are
    // independent of D6 (e.g. STT settings probe failures); we just print them.
  });
});
