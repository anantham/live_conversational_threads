# Soniox post-admission diagnostics

2026-10-07. All requests use synthetic keys, an in-memory database migrated from the checked-in journal, and a fake provider fetch. No provider or production request is permitted.

- A failure during request setup after durable admission returns a bounded public error, emits only the static diagnostic phase and error class when debug is enabled, and retains the unknown lease.
- A provider fetch that never settles ends at the ten-second deadline, retains its single reservation, and makes no automatic retry.
- A definitive provider refusal returns the safe refusal response and closes its lease while retaining the lifetime row.
- A failing diagnostic log sink cannot change the public transport-failure response or release an uncertain lease.

Prediction: the first three cases pass with the current Worker implementation. The log-sink case may reveal an unguarded diagnostic call; a failing assertion is evidence for the integration owner to assess before any source repair.

21:07 IST evidence: the first three pass, but the log-sink case rejects at the unguarded console.error instead of returning the public JSON error (21/22 combined checks). Integration root adds a guarded diagnostic call; all32new/issuer/recovery checks then pass. This confirms the logging-only availability defect. It does not establish the cause of the live Soniox setup failure.

2026-10-09 redirect compatibility repair intent (before implementation): the native captured failure is provider_fetch/TypeError with the runtime rejecting redirect:error. Add a fake edge transport that rejects that mode and otherwise returns a valid temporary key; the public Worker must succeed with one counted reservation and an acknowledged lease. Add redirected upstream responses with an untrusted Location; the Worker must return safe502/provider_refused, expose no key/location, make exactly one fetch with redirect:manual, and retain the attempt while closing the definitively refused lease. Baseline prediction: the edge-contract success case fails503; redirect behavior remains unsafe to rely on until manual is explicitly asserted. No live calls or production data in tests. Existing timeout/cancellation/consent/unknown-lease cases remain adjacent acceptance.

Baseline evidence: six new cases fail and all four existing diagnostic cases pass. The edge subset fake reproduces503/provider_fetch/TypeError with the unsupported mode; five redirect checks show error rather than manual. The minimal repair selects manual and retains the existing exact201-only response gate. Native captured evidence plus the primary workerd constructor independently support the runtime cause; fake tests alone cannot establish live issuance.
