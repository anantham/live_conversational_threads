# Gemini and OpenRouter choice

- A visitor explicitly selects Gemini (Google AI Studio) or OpenRouter before consenting; selection changes clear consent and refresh readiness without sending transcript content.
- Each server route uses only its configured endpoint/model/key. OpenRouter uses the replacement key when present; failures never fall back or retry. Secrets never reach browser responses.
- Both routes share the existing lifetime, unresolved-attempt, interval and token guards, with no migration or history reset. Cancellation/refusal/invalid maps retain charged reservations.
- Real SQLite fixtures exercise both provider responses, wrong consent, missing configuration, forged client policy, shared admission, cancellation and incomplete responses. Existing strict source-linked artifact validation remains unchanged.
- Publish to the existing Site, then test a bounded synthetic recording/map/download/public reopen journey; Google identity and private storage acceptance require actual sign-in, never mocked production identity.

2026-10-15 live-failure follow-up: refusal diagnostics must preserve admission and public refusal, remain off by default, bound reads to16KiB/two seconds, and log no provider message/content/key. Tests cover fixed enums, Gemini array envelope, unreadable/oversized bodies, sink failure, deadline and delivered cancellation. The proposed six-row/two-holder recovery SQL lives outside the deployment journal until separately approved; isolated SQLite checks prove exact preservation, two updates, replay no-op and refusal on count/cap/time/completion/release drift.
