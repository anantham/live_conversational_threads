# Testing

Last audited: 2026-07-04

This document describes the test suites that currently exist in this repository
and the commands contributors should use. Older testing plans in `docs/plans/`
and historical handovers are useful context, but this file is the current
testing entry point.

## Current State

Automated tests do exist. The old "0% / no test framework" status was stale.

- Backend tests use `pytest`, `pytest-asyncio`, and `pytest-cov`, installed from
  `lct_python_backend/requirements.txt`.
- Frontend unit tests use Vitest through `lct_app/vite.config.js`.
- Browser E2E tests use Playwright through `lct_app/playwright.config.ts`.
- GitHub Actions currently runs a Playwright smoke workflow on PRs/pushes to
  `main` (`.github/workflows/e2e.yml`) and a manual live STT E2E workflow
  (`.github/workflows/nightly-stt-e2e.yml`).
- There is not yet a universal CI gate for the full backend pytest suite,
  frontend Vitest suite, or coverage thresholds.

## Test Intent

- Preserve observable behavior at public boundaries: API responses, persisted
  rows, generated graph/artifact shapes, browser-visible UI, WebSocket messages,
  and error payloads.
- Keep unit tests focused on services, pure helpers, schema validation, and
  router contracts with mocked external services.
- Keep integration tests for database, WebSocket, import, STT, and subject-review
  paths that need real lifecycle behavior.
- Keep Playwright tests for user-visible flows and smoke coverage across routes,
  graph rendering, autosave, import, recording, mobile/fullscreen affordances,
  and meeting captions.
- Prefer realistic fixtures over minimal stubs, and avoid tests that only assert
  that a private helper was called.

## Backend Tests

Location:

```text
lct_python_backend/tests/
|-- unit/               focused service/router/helper tests
|-- integration/        DB/WebSocket/import/STT contract tests
|-- live_prayer/        live-prayer detector/runner/fact-check tests
|-- synthesis/          grounded synthesis tests
|-- fixtures/           sample transcripts and golden datasets
|-- test_*.py           older top-level tests still used by pytest
|-- conftest.py
`-- invariants.py
```

Run from the repo root:

```bash
./.venv/bin/python -m pytest -q lct_python_backend/tests/unit
./.venv/bin/python -m pytest -q lct_python_backend/tests/integration
./.venv/bin/python -m pytest -q lct_python_backend/tests
```

Run from inside `lct_python_backend/`:

```bash
PYTHONPATH=. ../.venv/bin/python -m pytest -q tests/unit
PYTHONPATH=. ../.venv/bin/python -m pytest -q tests/integration
```

Optional coverage:

```bash
./.venv/bin/python -m pytest lct_python_backend/tests --cov=lct_python_backend --cov-report=term-missing
```

Notes:

- Some integration/smoke tests are intentionally opt-in and require environment
  variables, provider URLs, audio fixtures, or a running local service. See
  `lct_python_backend/tests/README.md`.
- The Windows Anaconda environment has historically needed
  `-p no:hypothesispytest`; see handover notes before treating that as a product
  failure.
- Tests may emit an existing LibreSSL/urllib3 warning in some local Python
  environments.

## Frontend Unit Tests

Location:

```text
lct_app/src/**/*.test.{js,jsx,ts,tsx}
```

Configured in `lct_app/vite.config.js`:

- `environment: "jsdom"`
- `globals: false`
- includes `src/**/*.{test,spec}.{js,jsx,ts,tsx}`
- excludes Playwright tests under `lct_app/tests/**`

Run:

```bash
npm --prefix lct_app run test
npm --prefix lct_app run test -- src/services/readErrorMessage.test.js
```

Build and lint:

```bash
npm --prefix lct_app run build
npm --prefix lct_app run lint
```

Known state: `npm run build` is the broad frontend sanity check. Lint may surface
repo-wide backlog unrelated to a focused change; report that clearly instead of
silently treating lint as green.

## Playwright E2E

Location:

```text
lct_app/tests/e2e/
```

Config:

- `lct_app/playwright.config.ts`
- Base URL resolves from `../.frontend-port`, then `FRONTEND_PORT`, then `43173`.
- The config can reuse an existing dev server or start Vite automatically.
- Chromium is the active browser project, using installed Chrome by default.

Run:

```bash
npm --prefix lct_app run test:e2e
npm --prefix lct_app run test:e2e -- initialization
npm --prefix lct_app run test:e2e:ui
npm --prefix lct_app run test:e2e:debug
```

CI smoke currently runs:

```bash
npx playwright test initialization d4-color-mode-smoke d6-autosave-smoke fullscreen-button
```

Live STT E2E is manual/opt-in because it needs an audio fixture and can spend real
provider minutes:

```bash
RUN_STT_E2E=1 npm --prefix lct_app run test:e2e -- live-recording-stream
```

See `lct_app/docs/E2E-TESTING.md` for the Playwright runbook.

## Adding Tests

Before implementation, write a short Test Intent in the test file docstring or
in `tests/intent/<feature>.md` when a feature spans multiple files. Keep it to
2-5 bullets explaining the behavior and edge cases the test should protect.

Use the project's test-design rule: test behavior through public APIs and
observable outcomes, not private helper call order.

Good targets:

- API response shape and status code.
- Database row creation/update/deletion.
- Generated graph, artifact, or transcript event shape.
- Error messages that are specific enough to debug.
- Browser-visible state after user actions.
- WebSocket message contracts.

Avoid:

- Asserting a private helper was called without asserting the effect.
- Mocking so much of the system that the test can pass while behavior is broken.
- Fixtures with field names that do not match the real model/schema.
- Commenting out failing tests to make a run green.

## CI Workflows

- `.github/workflows/e2e.yml`: PR/push smoke workflow. Boots Postgres, FastAPI,
  Vite, and runs DB-independent Playwright smoke specs.
- `.github/workflows/nightly-stt-e2e.yml`: manual live-recording E2E workflow.
  It is not scheduled until a committed audio fixture exists.
- `.github/workflows/codex-review.yml`: currently disabled in the workflow guard
  because the referenced action does not exist.

## When Tests Fail

Treat failing tests as evidence. Capture:

- exact command,
- failure summary,
- whether the failure is in touched or untouched code,
- hypothesis for root cause,
- next diagnostic step.

If a failure is preexisting or out of scope, log it in `ISSUES.md` and add a
timestamped note to `docs/WORKLOG.md` in the same work session.
