# Conversation controls and service indicators

- Keep home navigation icon-only; More contains library destinations, files/export and settings with keyboard/Escape/outside dismissal and restored focus.
- Keep map controls reachable before and during recording; provider changes must immediately invalidate prior-provider health and consent.
- Two quiet indicators expose check latency, freshness, credit uncertainty and real-session success. Disabled/refused/timed-out/malformed responses cannot produce green; stale evidence expires.
- Read-only provider checks use fixed URLs, short deadlines, bounded JSON, single-flight caching and no quota mutation, session minting, generation, user content, secrets or numerical account balance in responses.
- Preserve consent, capture/pause/resume/cancellation, source traceability, downloads/private-save boundaries and navigation-loss warnings. Verify desktop/phone layout and focused plus combined regression suite.

- 16 October: Live transcription belongs in Settings; changing it never starts capture and it stays locked during active/paused recording. Start retains selected-mode consent and unavailable-provider refusal. Reuse the existing journey tests for this placement-only change.
- Signed-in access shows an accessible icon-only Sign out, no redundant Signed in label or guest sign-in instructions. Existing logout ordering, failure/retry, cancellation and guest reset checks remain authoritative.

- Profile opens the existing access panel from More on the recording page; no standalone account icon, no navigation or new recording, and closing returns keyboard focus to More. Existing sign-in/sign-out behavior stays unchanged.
- Routine browser-saving information and its library link live in Settings; browser-save failures stay visible with retry. Start is visually centered independently of the left status indicators; active controls remain usable on narrow screens. Verify placement visually rather than asserting CSS implementation.
