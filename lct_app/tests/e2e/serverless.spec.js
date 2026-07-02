import { test, expect } from '@playwright/test';

test.describe('Serverless BYOK Mode', () => {
  test('Falls back to ServerlessGate when backend is unreachable, accepts key, and boots app', async ({ page, context }) => {
    // 1. Mock the health check to force "unreachable" state
    await page.route('**/api/import/health', route => {
      route.abort('timedout');
    });

    // 2. Load the app
    await page.goto('/');

    // 3. Verify ServerlessGate appears
    await expect(page.locator('text=Serverless Mode').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Backend is unreachable')).toBeVisible();
    await expect(page.locator('text=Start Serverless Session')).toBeVisible();

    // 4. Enter API key
    const input = page.locator('input[type="password"]');
    await input.fill('sk-proj-test-123');
    
    // 5. Submit
    await page.locator('button:has-text("Start Serverless Session")').click();

    // 6. Verify transition to main app (e.g. the New Conversation / Browse page)
    // After submitting, the App should render <AppRoutes /> which typically defaults to NewConversation or Browse
    await expect(page.locator('text=Serverless Mode').first()).not.toBeVisible();
    
    // We expect to see "Live Conversational Threads" or a record button
    // (Assuming the default route is the Home page)
    await expect(page.locator('text=New').first()).toBeVisible({ timeout: 10000 });
    
    // 7. Verify the key was persisted in localStorage
    const storedKey = await page.evaluate(() => localStorage.getItem('lct_serverless_key'));
    expect(storedKey).toBe('sk-proj-test-123');
  });
});
