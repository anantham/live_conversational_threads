# Sites navigation dependency upgrade — test intent (2026-10-02)

- Upgrade only React Router and React Router DOM to7.18.2; preserve every unrelated locked package version/integrity.
- Existing public entry, optional sign-in, Browse/viewer routes, private UI and navigation/cancellation regressions must pass against the actual upgraded dependency tree, without modifying shared main-checkout dependencies.
- Build/export/compiled Worker boundaries remain intact; the native public preview must retain its URL, audience and synthetic-only private-storage flag.
- Exercise live Home → Browse → Home → private files and refresh after publication. Existing tests cover behavior; no version-mirroring unit test is added for this dependency-only change.
