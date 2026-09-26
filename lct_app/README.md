# LCT Frontend

This is the React/Vite frontend for Live Conversational Threads.

## Run Locally

The normal project entry point is the repo-root launcher:

```bash
../start.command
```

For frontend-only work from this directory:

```bash
npm install
npm run dev
```

Vite runs on `FRONTEND_PORT` or `43173` by default. Backend proxy targets are
resolved by `vite.config.js` from `../.backend-port`, `VITE_BACKEND_PORT`, or
`43180`.

## Main Surfaces

- `src/routes/AppRoutes.jsx` - route table.
- `src/pages/NewConversation.jsx` - live recording/session surface.
- `src/pages/ViewConversation.jsx` - saved conversation viewer.
- `src/pages/ShareConversation.jsx` - read-only share-token viewer.
- `src/pages/SubjectReview.jsx` - external subject privacy-review route.
- `src/pages/ThreadsViewer.jsx` - static `.threads` artifact viewer.
- `src/pages/settings/` - runtime and prompt settings.
- `src/components/audio/` - microphone, STT sockets, and live-session helpers.
- `src/components/graph/` and `src/components/MinimalGraph.jsx` - graph rendering.
- `src/services/` - API wrappers.

Read `../PRODUCT.md` and `../DESIGN.md` before UI work. The app should feel like
a calm product instrument, not a generic SaaS dashboard.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run test
npm run test:e2e
npm run test:e2e:ui
npm run test:e2e:debug
```

Vitest discovers `src/**/*.{test,spec}.{js,jsx,ts,tsx}`. Playwright tests live
under `tests/e2e/`; see `docs/E2E-TESTING.md`.
