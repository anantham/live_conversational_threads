# Audio import optional private history test intent

- Preserve browser-local default and ephemeral archive behavior. Mount/readiness, import and local reopen never upload content or publish; only deliberate per-file private-save clicks may POST.
- Accept current same-origin JSON sign-in plus enabled/configured/private, non-synthetic storage metadata. Guest, unknown, stale/refused or invalid status cannot be represented as ready; refresh is explicit and bounded.
- Validate size/type/name before sending bytes, recheck sign-in at save, require matching private ready acknowledgement, and retain source file/transcript/map and local retention on every outcome.
- One upload at a time; active processing/generation blocks saves. Cancellation/timeout/unmount/late receipt never claims success or automatically retries, and navigation protects unfinished work.
- Exercise audio/transcript/map bytes and IDs through public page controls with real request/session adapters and synthetic network responses. Existing Worker owner-isolation tests remain unchanged; no provider/bot/live private/public write is part of fixture checks.
