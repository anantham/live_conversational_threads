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

Boundaries: the Worker is not run. `tests/e2e-sites/siteApi.js` answers each `/api` path with a
recorded shape, fails a test on any `/api` path it does not know, and refuses requests to other
hosts. Nothing reaches a provider, spends a generation attempt or signs anyone in.

A disappearing element is checked by sampling, not with a retrying assertion: `toHaveCount(0)`
waits for the element to go away and so passes even if it flashed (found while red-proving).

Each spec was red-proved on 2026-11-26 by removing the fix it guards (8 mutations, all failed),
and the suite passes on both `main` and `integ/sites-combined`.
