# Soniox post-admission diagnostics

2026-10-07. All requests use synthetic keys, an in-memory database migrated from the checked-in journal, and a fake provider fetch. No provider or production request is permitted.

- A failure during request setup after durable admission returns a bounded public error, emits only the static diagnostic phase and error class when debug is enabled, and retains the unknown lease.
- A provider fetch that never settles ends at the ten-second deadline, retains its single reservation, and makes no automatic retry.
- A definitive provider refusal returns the safe refusal response and closes its lease while retaining the lifetime row.
- A failing diagnostic log sink cannot change the public transport-failure response or release an uncertain lease.

Prediction: the first three cases pass with the current Worker implementation. The log-sink case may reveal an unguarded diagnostic call; a failing assertion is evidence for the integration owner to assess before any source repair.

21:07 IST evidence: the first three pass, but the log-sink case rejects at the unguarded console.error instead of returning the public JSON error (21/22 combined checks). Integration root adds a guarded diagnostic call; all32new/issuer/recovery checks then pass. This confirms the logging-only availability defect. It does not establish the cause of the live Soniox setup failure.
