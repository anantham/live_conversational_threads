# Gemini review receipt gate test intent

- Exercise the public PowerShell review and merge CLI with isolated fake `git` and `gh` executables; no network or live PR mutation.
- Accept a completed Gemini receipt only when the exact PR identity, reviewed and permitted excluded file inventory, successful tool-free verdict, and transport manifest are present.
- Refuse stale heads, findings, malformed or unknown schemas, a wrong AI family, tool attempts, and any exclusion of source code.
- Keep required checks in the merge path and pin the reviewed head with `--match-head-commit`; refuse a head change while checks run.
