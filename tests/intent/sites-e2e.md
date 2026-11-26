# Sites-mode end-to-end tests

Specs: `lct_app/tests/e2e-sites/`, config `lct_app/playwright.sites.config.ts`, run with
`npm run test:e2e:sites` (CI: `.github/workflows/sites-e2e.yml`).

Why: the Site (production) uses its own data provider, account panel and service checks.
The self-hosted e2e suite never exercises them, and the 2026-11-05 `?src=` failure passed
every unit test. These tests load the real `build:sites` bundle in Chromium.

- A guest's first Home visit shows a compact Sign in control and the Privacy link; the account
  panel opens only when asked. No Bookmarks door on the Site.
- A `/view?src=` link opens the map, and the Site's cookies are not sent with it, even to a
  same-origin URL. A missing file is explained in plain words.
- On `/new`, with the live Site's own recorded check results: a Soniox key that cannot list
  models reads "Available" (not red); a used-up shared limit reads amber "Not available right
  now"; a key that fails authentication reads red "Not reachable". A check that answers within
  2 s shows no status block and no "not available yet" line.

Boundaries: the Worker is not run. `tests/e2e-sites/siteApi.js` answers same-origin `/api` paths
(GET unless stated) with recorded shapes. It fails a test on any `/api` path or method it does not
know and on any request to another origin, including other ports on localhost. Test-specific
routes are scoped to the test server's origin, never a glob that would also answer another host.
Nothing reaches a provider, spends a generation attempt or signs anyone in.

Things that must never appear, even briefly, are watched with `recordAppearances` (a
MutationObserver from first paint), not a retrying assertion: `toHaveCount(0)` waits for a flashing
element to go away and so passes anyway (found while red-proving). The slow-check test delays the
status answers 1.25 s (past the 1 s tick, under the 2 s threshold) and keeps watching until 0.7 s
after they answer.

Red-proved on 2026-11-26 by removing or weakening each guarded fix (11 mutations, including a
1-second threshold, an unauthenticated key read as available and a fetch to production: all
caught). The suite passes on `main` and `integ/sites-combined`, and 30/30 with each test repeated 5x.
