# Private cloud conversation reopening

2026-10-02. Synthetic fixed conversation/files/identities only; no actual transcript, private history, provider or new spend.

Checkpoint scope: the bounded authenticated content reader and its synthetic tests are implemented first. Viewer integration, private timing presentation, the second fixture and native reopening proof below remain pending; this checkpoint does not add a user-facing Open action or activate personal uploads.

- Open a ready private version2 .threads file from the authenticated library using only the existing same-origin content endpoint. Bound declared/received bytes to2MiB, reject malformed content/metadata and preserve guest/other-owner denial. No external source, local-library, public-catalog or unauthenticated fallback.
- Keep chosen ID/content in React memory on /private-files. Opening, speaker edits and closing do not remember the private artifact in IndexedDB, URL/router state, localStorage or clipboard/share links. Existing public/local/Drive opening remains unchanged.
- Display load stage/elapsed/unknown remaining promptly; manual retry, cancel, timeout and navigation abort/reader cleanup remain understandable. Record at most12 payload-free receipts in a separately grouped private-conversation timing key.
- A second fixed nonpersonal .threads fixture enables owner save, native refresh/reopen/map/transcript proof while synthetic mode still rejects all personal or modified bytes. The existing text/fence verification contract remains unchanged; capacity/recovery and ownership apply equally to both fixtures.
- Verify realSQLite owner/guest/other-owner API behavior, readable exact stream bytes and explicit storage selection; synthetic UI exercises successful graph/discussion, view-only edits, failed/slow/cancel/retry/close and malicious route source exclusion. Native fixed-fixture proof is separate from real account isolation, real recordings, intelligent extraction and domain cutover.
