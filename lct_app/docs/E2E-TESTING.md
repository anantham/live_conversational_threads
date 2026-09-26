# E2E Testing

Last audited: 2026-07-04

The frontend E2E suite uses Playwright and lives under `lct_app/tests/e2e/`.
It verifies browser-visible behavior: app initialization, graph rendering,
autosave, import/recording flows, fullscreen/mobile affordances, tangent views,
and meeting captions.

## Configuration

Playwright config: `lct_app/playwright.config.ts`.

Important behavior:

- `testDir` is `./tests/e2e`.
- Chromium is the active project. It uses installed Google Chrome by default via
  `channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || "chrome"`.
- Base URL resolves from `../.frontend-port`, then `FRONTEND_PORT`, then `43173`.
- The resolved base URL is also exported as `PLAYWRIGHT_BASE_URL`.
- The config can reuse an existing Vite server locally, or start one with
  `npm run dev -- --host 0.0.0.0`.
- Screenshots are captured on failure, video is retained on failure, and traces
  are collected on first retry.

## Run

From `lct_app/`:

```bash
npm run test:e2e
npm run test:e2e -- initialization
npm run test:e2e:ui
npm run test:e2e:debug
npm run test:e2e:headed
npm run test:e2e:report
```

From the repo root:

```bash
npm --prefix lct_app run test:e2e
npm --prefix lct_app run test:e2e -- meeting-live-caption
```

Install browsers if needed:

```bash
npx playwright install chromium
```

## Current Specs

```text
tests/e2e/audio-graph-zoom.spec.ts
tests/e2e/d4-color-mode-smoke.spec.ts
tests/e2e/d6-autosave-smoke.spec.ts
tests/e2e/fullscreen-button.spec.ts
tests/e2e/graph-visualization.spec.ts
tests/e2e/hierarchy-tabs-visual.spec.ts
tests/e2e/import-audio.spec.ts
tests/e2e/initialization.spec.ts
tests/e2e/live-recording-stream.spec.ts
tests/e2e/meeting-live-caption.spec.ts
tests/e2e/mobile-audit.spec.ts
tests/e2e/quota-recording.spec.ts
tests/e2e/tangent-view-stream.spec.ts
```

`tests/thematic-view.spec.js` is outside the configured `tests/e2e/` directory
and is not part of the default Playwright run.

## CI

`.github/workflows/e2e.yml` runs a PR/push smoke set:

```bash
npx playwright test initialization d4-color-mode-smoke d6-autosave-smoke fullscreen-button
```

The workflow boots Postgres, runs Alembic migrations, starts FastAPI on `43181`,
installs frontend dependencies, installs Chromium, and runs the smoke specs.

`.github/workflows/nightly-stt-e2e.yml` is manual-only. It runs
`live-recording-stream` with `RUN_STT_E2E=1` and requires an audio fixture.

## Writing E2E Tests

Prefer semantic locators:

```ts
await page.getByRole("button", { name: "Upload" }).click();
await expect(page.getByText("Conversation")).toBeVisible();
```

Good E2E tests:

- assert user-visible behavior, not React internals;
- make their own data or clearly document required fixtures;
- wait for conditions rather than fixed timeouts;
- avoid dependence on test order;
- leave enough failure context through screenshots, traces, or console output.

Use `page.waitForTimeout()` only as a debugging tool. If a flow needs a real wait
for background processing, wait on the UI state, network response, or persisted
artifact that proves the behavior happened.

## Common Issues

- If tests hit the wrong port, check `.frontend-port`, `FRONTEND_PORT`, and
  `PLAYWRIGHT_BASE_URL`.
- If Vite cannot reach the backend, check `.backend-port` or
  `VITE_BACKEND_PORT`; `vite.config.js` proxies `/api`, `/ws`,
  `/conversations`, `/save_json`, `/get_chunks`, `/generate`, and `/export`.
- If Chrome is unavailable, set `PLAYWRIGHT_CHROME_CHANNEL` or install
  Playwright Chromium.
- `live-recording-stream` is opt-in and expects an audio fixture; do not treat a
  missing fixture as a general app failure.
