# Parallel Site and native identity — test intent

- Exercise the Worker session endpoint with synthetic trusted identity, no identity, whitespace identity, a service credential and wrong methods; return no email, credential or caller-supplied owner field, and never cache identity responses.
- Preserve proxy behavior and unsupported API responses. Serve browser deep links through the asset shell while missing asset files and non-navigation requests keep their errors; dispatch-owned sign-in paths must not be implemented by the app.
- Exercise the public source-export tool against synthetic fixtures: include required technical source and favicon, exclude secrets/data/history/test fixtures/public artifacts, refuse nonempty destinations and symlink source paths without modifying output.
- Build both client and Worker using no environment files and no ambient VITE variables. Inspect the final output to confirm only approved static assets, no synthetic ambient credential marker and a callable default.fetch without Node globals.
- Inspect both output directories: the Worker build must contain only its JavaScript entrypoint, with no copied public directory or unrelated artifacts. The bounded source export already excludes such data, but direct canonical builds must enforce the same boundary.
- Native deployment and actual signed-in identity remain separate evidence gates: local trusted-header fixtures cannot prove platform authentication or header-spoof rejection.
