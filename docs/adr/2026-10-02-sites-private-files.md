# Sites private file storage

Date: 2026-10-02. Status: implementation stage under the approved cloud migration; real-data activation pending.

The public app remains accessible without sign-in. This first storage slice handles only explicitly private files; anonymous public conversations remain a separate required milestone. Opening a local file never uploads it.

Store private metadata in the Site's D1 binding and bytes in its private R2 binding. The Worker derives the owner exclusively from Sites dispatch identity and checks ownership before accessing a blob. Client owner/visibility fields cannot publish or reassign a file. Serve bytes as attachments with no-store, nosniff and a restrictive content policy. No owner account tokens or provider keys participate.

Uploads reserve capacity with one conditional SQLite INSERT; all states consume capacity. Blobs use server-created immutable keys. A row becomes ready only after successful blob persistence. Deletion hides the row first, removes bytes, then releases its reservation. Failures retain an accounted row for owner cleanup. Deleting an in-progress upload is rejected to avoid racing an unfinished blob write; crash-abandoned staging rows require a later reconciler before real-data activation.

Preview ceilings are 2 MiB per upload, 10 MiB/50 records per user, 20 MiB/200 records per Site and four concurrent upload bodies per Worker isolate. These are capacity safeguards, not a monetary spending limit or globally distributed rate limiter. Default writes are disabled. Public write abuse controls, retention/reconciliation, the private file UI and a user-approved activation policy remain required before enabling real uploads.

Prediction: real-migration API tests show complete user separation and atomic capacity accounting; native deployment establishes empty DB/blob bindings without publishing user data. Confidence: 0.9 for this bounded source contract, native wiring remains to be verified. Fallback: retain the prior public version and leave writes disabled if the platform cannot apply the generated initial migration.

## 2026-10-02 amendment — recovery and synthetic file UI

The initial migration is applied and immutable. Append generated `0001_new_dragon_man.sql` and its snapshot/journal entry; preserve the original SQL, snapshot and journal entry. The new table stores only random object keys and creation times for erasure fences.

Use conditional create-only R2 uploads. Owner deletion first hides access, replaces any blob with an empty object, then atomically records the empty key and removes the file metadata. The retained empty object prevents a delayed original upload from recreating private bytes. Never infer writer termination from a clock or expire these fences by age. Count active records plus fence records against a 200-key lifetime preview creation budget, in addition to the existing byte/count ceilings. This lifetime cap requires a future production capacity policy; deleting files does not restore its creation slots.

Owners can explicitly reconcile a staging record whose committed blob has the complete reserved size. The staging-to-ready update is conditional; an original upload finishing after successful recovery returns the ready result rather than erasing it. Missing bytes stay unavailable and can be safely discarded using the same erasure fence. Uncertain erasure/ledger failures retain the reservation and expose an owner cleanup retry.

Add a separate `/private-files` screen without gating Home, New or Browse. Status precedes listing; guests receive optional sign-in for private files. Explicit uploads/downloads/deletion, staging recovery, elapsed status, cancellation, timeout/retry and navigation cleanup are visible. Payload-free timing history is bounded to 12 operations and does not invent an ETA. Effect cancellation cannot clear a newer StrictMode operation.

For native verification only, `LCT_PRIVATE_STORAGE_ENABLED=synthetic` accepts the exact fixed nonpersonal `lct-storage-check.txt` bytes/type/name and hides personal file selection. Synthetic deletion also attempts a conditional late write against the retained empty fence; cleanup succeeds only if that write is refused. No provider key or real recording is activated. The broader beta still requires guest-public confirmation/controls, second real-account isolation, retention, advisory review and provider spending limits. Confidence: 0.9 for the tested source; actual native conditional behavior remains a verification gate. Fallback: leave personal uploads inactive and keep the current public version if native proof fails.

## 2026-10-02 07:24 IST amendment — approved manual retention

The human selected: keep signed-in private recordings and files until the user deletes them. This settles the retention policy only, preserving remaining second actual-account, real-file, funding, capacity and release gates. No automatic expiry, broad personal-upload activation, provider processing, public sharing or domain change is authorized by that selection.

Add the same brief disclosure beside deliberate private file/audio/finalized-transcript saves: cloud copies stay until deletion and private saving does not publish them. The existing explicit save/upload action provides affirmative intent; selecting a file or ending capture must not trigger any POST. Distinct accessible description IDs connect each action to the disclosure. Preserve synthetic-only/inactive/guest behavior, authenticated same-origin uploads and existing cancellation/recovery/deletion semantics. No new asynchronous flow or backend/schema is needed. Hypothesis: clear adjacent copy makes retention and visibility reviewable before the deliberate action; confidence0.95. Prediction: actual component request-boundary tests and inactive native layout pass. Fallback: retain synthetic-only storage and local files if a privacy or rendering gate fails.
