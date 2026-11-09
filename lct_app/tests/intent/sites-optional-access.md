# Test intent: optional Sites access

- The dedicated Sites build renders the public route and a keyless browser-local provider without a backend health probe or key gate.
- A missing session (401) shows guest access; only a validated authenticated response shows signed-in status, without exposing identity.
- Session errors and timeouts leave public content usable and offer a retry; a slow check shows elapsed time and an honest unknown estimate.
- Unmount aborts the session request and clears its timers; retry replaces the previous result.
- In Sites Browse, keep the local .threads open/drop/library and draft controls while omitting inherited owner audio and server-history sections and their requests.
- In other builds, retain the existing server-history and owner audio sections, including the listSaved request.
