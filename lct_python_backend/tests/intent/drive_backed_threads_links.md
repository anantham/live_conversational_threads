# Test intent — Drive-backed recipient Threads links

- A recipient opens a stable LCT URL containing only an opaque Drive file id.
- Google Drive remains the authorization boundary; LCT never receives or stores a refresh token.
- The browser keeps the short-lived access token in memory and validates downloaded bytes as a `.threads` artifact before rendering.
- Permission, account-selection, missing-file, malformed, and oversized failures stay explicit and recoverable.
- Existing local file, IndexedDB library, and hosted `src` opener paths remain unchanged.
