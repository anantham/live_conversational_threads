# Compact recording and access controls

2026-10-09. User-approved UI slice; synthetic sessions only, no microphone or paid provider requests.

- Opening Record asks for fresh participant permission in an accessible dialog; no capture or Soniox request starts before confirmation. Local mode has no Soniox consent, transcription mode discloses its destination. Cancel, Escape and navigation do not start capture.
- Remember only the general recording explanation after confirmation, never participant/provider permission. Every new recording starts unchecked, including replacement and retries; blocked browser storage does not prevent recording.
- After confirmation the dialog disappears and active controls show stage, elapsed time, Stop and Cancel without the old consent card. Existing setup deadlines, failed recording recovery, local download and explicit private/map processing choices remain intact.
- Closing the access notice remembers its presentation preference without changing identity. A compact control and existing private-page sign-in links reopen it; privacy, sign-out and unavailable-provider behavior remain reachable.
