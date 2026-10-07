# Soniox mint diagnostics

2026-10-07. Test only with synthetic credentials, a fully migrated in-memory database and mocked upstream responses through the public Worker route.

- With debug disabled, a failed transport logs nothing and retains an uncertain reservation.
- With debug enabled, a transport failure records the static phase, allowlisted class and bounded message after secret, key-pattern, long-token and control-character redaction; the public response remains unchanged.
- A malformed provider body and a failed D1 lease acknowledgement report distinct phases and bounded HTTP status without provider payload or key text.
- Consent, successful issuance, lifetime count and null-lease uncertainty keep their existing public behavior. No provider or native Site call is part of these tests.
- On the public status GET, debug off emits no capability log; debug on emits only fixed type labels for the incoming signal and a fresh local AbortController, even while Soniox is disabled. The status JSON, provider-call count and session-row count stay unchanged.
