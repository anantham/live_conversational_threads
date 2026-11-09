# Sites Soniox live transcription

2026-10-02. No real keys, microphone recordings or billable provider requests in validation.

- Through the Worker public API, disabled/missing/unconfirmed policy never calls Soniox; same-origin consent is mandatory, account-only and public issuer modes remain explicit, and the main key never enters a public response or log.
- Real generated SQLite proves atomic lifetime/rate/concurrency reservations. Failed, timed-out, malformed, cancelled and uncertain mint attempts keep their reservation; no automatic retry or configuration reset releases it.
- The exact upstream request contains only a fixed STT usage scope, single-use/short expiry/provider session cap and an unrelated opaque ID. Bound both request/response waits and reject unreadable success/error bodies without exposing them.
- Browser stream tests observe the fixed protocol, binary audio, finalized/provisional text, end-of-audio/final output, cancellation/timeouts/backpressure and cleanup. No private-helper or call-count-only assertions.
- Capture/UI integration will verify permission latency/late resolution, stop/final chunks, byte/session limits, provider failure, navigation cleanup, optional private save and public entry without any Python/Tailscale call. Native paid proof remains separate and requires approved, checked billing limits.
