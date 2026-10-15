# Sign-in icon buttons

- Present ChatGPT and Google as bordered icon-and-label controls, preserving their accessible names and existing destinations/handlers.
- Keep the compact Sign in / Account trigger keyboard reachable with a 44px touch target.
- Reuse auth regressions for guest, signed-in, refusal, retry and cancellation; visually check desktop and narrow mobile layouts.
- Styling-only exception: no new tests mirroring CSS/SVG implementation; no credential, provider, storage or inference changes.
