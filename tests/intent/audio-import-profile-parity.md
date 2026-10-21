# Audio import profile navigation parity

- New and restored /import-audio routes, including trailing slash, share the recorder's existing More -> Profile behavior for guest and signed-in sessions. No automatic expanded account card or second floating trigger.
- Repeated More/Profile open, icon close, explicit account hash and focus restoration remain functional; outside conversation pages keep their current account presentation. No logout, login, provider call or identity/storage change is caused by navigation.
- Reuse existing auth/refusal/cancellation coverage and verify actual narrow layout; no live authentication, audio submission, inference or bot is required.
