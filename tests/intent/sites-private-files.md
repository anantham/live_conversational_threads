# Sites private files — test intent (2026-10-02)

- Exercise the public Worker API against real SQLite running the generated migration and an in-memory R2-compatible byte store; verify uploaded bytes, metadata and ownership.
- Private list/read/delete require the trusted Sites identity. A service credential, request owner field, anonymous visitor or another user cannot access the file. Writes require the exact same origin and custom write header.
- Enforce byte/count reservations atomically, including unfinished uploads and deletions. Concurrent reservations cannot exceed limits; oversized bodies and malformed .threads data never reserve space.
- A failed upload is never ready. Failed blob deletion retains a hidden/accounted record and supports owner cleanup retries. In-progress uploads cannot be deleted concurrently.
- The default deployment keeps writes disabled pending the activation/retention decision. Public app entry and optional sign-in remain unchanged; no owner history or paid provider is used.
