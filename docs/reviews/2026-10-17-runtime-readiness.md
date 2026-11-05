# Isolated non-recording runtime acceptance — 17 October 2026

Outcome: prepare the existing approved Asus recovery for actual schema, private API and storage acceptance before any worker or public relay.

Source inventory: `attendee_stack/recovery/check_runtime.py`, `start_runtime_after_build.ps1`, with unchanged `bootstrap.py` as review context. No runtime environment, credentials, account/participant information, logs, recordings or private artifacts were sent. Root owns integration in the existing `codex/lct-inference-choice` worktree. No new dependency, provider or hosting account.

Test intent is in the Python probe docstring and recovery README. Actual wrong-namespace subprocess exits1 with `isolated environment` and no imports or writes. Positive checks require the real initialized recovery runtime; no mock establishes acceptance. Windows parser and task dispatch are preparation, not runtime proof.

The probe validates the actual creation serializer without saving a bot, empty DB/API correspondence, exact authenticated/guest/wrong-key JSON routes, private S3 exact bytes/ranges and anonymous403. It retains one tiny unique synthetic object. The wrapper refuses existing app/worker holders and a busy listener, runs import/migration/bootstrap in the dedicated namespace, starts app on loopback only, checks identity and acceptance, and stops its newly started app on rejection. It preserves credential bytes and existing completion receipts. No worker, public route or bot is started.

Independent review: Google Gemini `gemini-4-argon-medium`, existing authenticated AGY subscription, fresh plan conversation with no tools/edits/external actions requested. Exact saved source-only packets were inspected and scanned; no new paid intermediary.

- Probe final review: conversation `0f90fe8c-eb2d-4e9b-ace7-1622696cb52b`,18.734s, PASS/no findings.6754bytes, SHA256 `ca3e906b62609feb7f8190112293c2d2e840f76021411a4d1fc871dbe04ec6d1`. Earlier supported false-pass finding repaired with exact JSON error and redirect assertions.
- Wrapper initial review: conversation `bf374fc6-2dc0-4648-a59f-7aa7bdd0410c`,78.174s. Three supported findings repaired: duplicate invocation must not clobber receipts; stopped app holders must be refused and one resulting app required; rejected new app must stop.
- Final coherent review: conversation `14ebb812-3504-4edf-b72b-546ef1832781`,28.370s, PASS/no blockers/findings.15748bytes, SHA256 `d1a94344860e24be9db7bd6e50ac718d9086364f2679d5a5d9b0bc49a0bfbad5`. Optional removal of the public probe and an extra running-state assertion were deferred: retained probe assists inspection, and actual HTTP acceptance already checks liveness.

Final source hashes:
- check_runtime.py: `3a26b62ed2129178953debd3d84ef76aa7ffc65364e7d6116a381e7ad991cde6`
- start_runtime_after_build.ps1: `5e3969d8b95f1e256df064f490e76d68fa9d3b600834bab2ebf03fcbc18ca70e`

Actual build completion and real API/storage acceptance remain pending; this receipt does not establish Meet captions, threads, recorded audio or deployment acceptance.
