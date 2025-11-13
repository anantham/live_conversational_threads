# E2E Testing for Live Conversational Threads

Comprehensive end-to-end testing infrastructure using Playwright for browser automation.

## Overview

The E2E test suite verifies that the Live Conversational Threads app works correctly in real browser environments. Tests cover:

- **App Initialization**: Verifies the app loads without errors
- **Graph Visualization**: Tests conversation graph rendering and interactions
- **Navigation**: Ensures routing and page transitions work
- **Responsive Design**: Validates layout across different screen sizes
- **User Interactions**: Tests clicks, zooms, and other user actions

## Setup

### Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- Playwright browsers (installed automatically)

### Installation

Playwright and browsers are already configured. To reinstall browsers manually:

```bash
npx playwright install chromium
```

## Running Tests

### All Tests (Headless)

```bash
npm run test:e2e
```

Runs all tests in headless mode (no visible browser). Best for CI/CD.

### Interactive UI Mode

```bash
npm run test:e2e:ui
```

Opens Playwright's interactive test runner with:
- Visual test execution
- Time travel debugging
- Watch mode for development
- Test filtering and search

### Debug Mode

```bash
npm run test:e2e:debug
```

Runs tests with:
- Playwright Inspector
- Step-by-step execution
- Browser visible
- Breakpoint support

### Headed Mode

```bash
npm run test:e2e:headed
```

Runs tests with visible browser (good for seeing what's happening).

### View Test Report

```bash
npm run test:e2e:report
```

Opens the HTML test report showing:
- Test results
- Screenshots (on failure)
- Videos (on failure)
- Traces for debugging

## Test Structure

```
lct_app/
├── tests/
│   └── e2e/
│       ├── initialization.spec.ts       # App loading & basic functionality
│       ├── graph-visualization.spec.ts  # Graph/canvas interactions
│       └── debug-console.spec.ts        # Debug helper for console logs
├── playwright.config.ts                 # Playwright configuration
└── docs/
    └── E2E-TESTING.md                   # This file
```

## Writing Tests

### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app before each test
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('should do something', async ({ page }) => {
    // Arrange: Set up test conditions
    const button = page.locator('button.my-button');

    // Act: Perform action
    await button.click();

    // Assert: Verify result
    await expect(page.locator('.result')).toBeVisible();
  });
});
```

### Common Patterns

#### Waiting for Elements

```typescript
// Wait for element to be visible
await page.locator('.my-element').waitFor({ state: 'visible' });

// Wait for network idle
await page.waitForLoadState('networkidle');

// Custom timeout
await expect(page.locator('.slow-element')).toBeVisible({ timeout: 10000 });
```

#### Interacting with Elements

```typescript
// Click
await page.locator('button').click();

// Type text
await page.locator('input').fill('Hello World');

// Select from dropdown
await page.locator('select').selectOption('value');

// Hover
await page.locator('.item').hover();
```

#### Assertions

```typescript
// Visibility
await expect(page.locator('.element')).toBeVisible();
await expect(page.locator('.hidden')).toBeHidden();

// Text content
await expect(page.locator('.title')).toHaveText('Expected Text');
await expect(page.locator('.body')).toContainText('partial match');

// Attributes
await expect(page.locator('button')).toHaveAttribute('disabled', '');

// Count
await expect(page.locator('.item')).toHaveCount(5);

// URL
await expect(page).toHaveURL('/expected-path');
```

## Configuration

### Playwright Config (`playwright.config.ts`)

Key settings:

```typescript
{
  testDir: './tests/e2e',        // Test location
  fullyParallel: true,            // Run tests in parallel
  retries: process.env.CI ? 2 : 0, // Retry on CI only
  use: {
    baseURL: 'http://localhost:5173',  // Vite dev server
    trace: 'on-first-retry',           // Trace on retry
    screenshot: 'only-on-failure',     // Screenshots on fail
    video: 'retain-on-failure',        // Videos on fail
  },
  webServer: {
    command: 'npm run dev',             // Start dev server
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
}
```

### Supported Browsers

Currently configured for:
- ✅ Chromium (Chrome, Edge)
- ⬜ Firefox (commented out)
- ⬜ WebKit (Safari - commented out)

To test additional browsers, uncomment projects in `playwright.config.ts`.

## Debugging

### Debug Console Test

Use `debug-console.spec.ts` to troubleshoot console message issues:

```bash
npm run test:e2e tests/e2e/debug-console.spec.ts
```

This test:
- Captures all console messages with timestamps
- Displays message types and counts
- Helps identify timing issues

### Using Playwright Inspector

```bash
npm run test:e2e:debug
```

Features:
- Step through tests line by line
- Inspect page state at each step
- Modify locators in real-time
- Record new tests

### Taking Screenshots

Add to any test:

```typescript
await page.screenshot({ path: 'screenshot.png' });
```

### Console Logging

```typescript
// Log from test
console.log('[TEST] My debug message');

// Capture browser console
page.on('console', (msg) => {
  console.log('[BROWSER]', msg.text());
});
```

## Common Issues

### Tests Timeout

**Problem**: Tests timeout waiting for page load or elements.

**Solutions**:
- Increase timeout: `await expect(element).toBeVisible({ timeout: 10000 })`
- Use better wait strategy: `page.waitForLoadState('networkidle')`
- Check if dev server is running

### Element Not Found

**Problem**: Locator can't find element.

**Solutions**:
- Verify selector with Playwright Inspector
- Wait for element: `await element.waitFor()`
- Use more specific locator: `page.getByRole('button', { name: 'Submit' })`

### Console Errors in Tests

**Problem**: Test fails due to console errors.

**Solutions**:
- Filter benign errors (ResizeObserver, favicon 404)
- Fix actual errors in application code
- Use `page.on('console')` to inspect messages

### Flaky Tests

**Problem**: Tests pass/fail inconsistently.

**Solutions**:
- Add explicit waits: `await page.waitForLoadState('networkidle')`
- Use Playwright's auto-waiting features
- Avoid `page.waitForTimeout()` except for debugging
- Increase retries in CI: `retries: 2`

## Best Practices

### ✅ DO

- Use semantic locators: `getByRole()`, `getByLabel()`, `getByText()`
- Wait for conditions, not arbitrary timeouts
- Test user-visible behavior, not implementation
- Write independent tests (no shared state)
- Use Page Object Model for complex flows
- Keep tests focused on one feature

### ❌ DON'T

- Don't use `waitForTimeout()` unless absolutely necessary
- Don't rely on element indexes (`.first()`, `.nth(1)`)
- Don't test internal React state
- Don't make tests dependent on each other
- Don't use overly specific CSS selectors
- Don't skip cleanup between tests

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

## Test Coverage

Current test suites:

| Test Suite | Tests | Status | Coverage |
|------------|-------|--------|----------|
| Initialization | 5 | ✅ Ready | App load, navigation, responsive |
| Graph Visualization | 7 | ✅ Ready | Canvas, nodes, zoom, views |
| Debug Console | 2 | ✅ Ready | Debugging helper |

**Next to add**:
- Conversation upload flow
- Analytics features (bias, frame, simulacra)
- API integration tests
- Error handling scenarios

## Resources

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright API Reference](https://playwright.dev/docs/api/class-playwright)
- [Debugging Tests](https://playwright.dev/docs/debug)
- [Test Generators](https://playwright.dev/docs/codegen)

## Contributing

When adding new tests:

1. Place tests in `tests/e2e/` with descriptive names
2. Group related tests in `test.describe()` blocks
3. Add `test.beforeEach()` for common setup
4. Use clear test names: `should do X when Y`
5. Add comments for complex interactions
6. Update this documentation with new test suites
7. Verify tests pass: `npm run test:e2e`

## Support

For issues or questions:
- Check [Common Issues](#common-issues) section
- Review Playwright docs
- Run debug test to inspect behavior
- Use Playwright Inspector for interactive debugging
