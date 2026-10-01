# Sites private file storage

Date: 2026-10-02. Status: implementation stage under the approved cloud migration; real-data activation pending.

The public app remains accessible without sign-in. This first storage slice handles only explicitly private files; anonymous public conversations remain a separate required milestone. Opening a local file never uploads it.

Store private metadata in the Site's D1 binding and bytes in its private R2 binding. The Worker derives the owner exclusively from Sites dispatch identity and checks ownership before accessing a blob. Client owner/visibility fields cannot publish or reassign a file. Serve bytes as attachments with no-store, nosniff and a restrictive content policy. No owner account tokens or provider keys participate.

Uploads reserve capacity with one conditional SQLite INSERT; all states consume capacity. Blobs use server-created immutable keys. A row becomes ready only after successful blob persistence. Deletion hides the row first, removes bytes, then releases its reservation. Failures retain an accounted row for owner cleanup. Deleting an in-progress upload is rejected to avoid racing an unfinished blob write; crash-abandoned staging rows require a later reconciler before real-data activation.

Preview ceilings are 2 MiB per upload, 10 MiB/50 records per user, 20 MiB/200 records per Site and four concurrent upload bodies per Worker isolate. These are capacity safeguards, not a monetary spending limit or globally distributed rate limiter. Default writes are disabled. Public write abuse controls, retention/reconciliation, the private file UI and a user-approved activation policy remain required before enabling real uploads.

Prediction: real-migration API tests show complete user separation and atomic capacity accounting; native deployment establishes empty DB/blob bindings without publishing user data. Confidence: 0.9 for this bounded source contract, native wiring remains to be verified. Fallback: retain the prior public version and leave writes disabled if the platform cannot apply the generated initial migration.
