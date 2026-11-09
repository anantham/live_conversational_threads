# Browser saving and optional cloud copies

Status: approved by Aditya, 16 October 2026. Integration owner: root.

The current user ruling supersedes the cloud recording ADRs' tab-only retention default. New conversations save audio parts, confirmed transcript/timing and the latest complete map/threads artifact in this browser without requiring sign-in. A Settings preference selects ephemeral recording: conversation content remains in memory and is not written to browser storage. Changing the default affects the next recording; existing saved copies are never silently deleted. Imported files and deliberate downloads remain explicit separate actions.

Use IndexedDB for blobs and structured conversation snapshots, preserving the existing imported Threads library. Save audio chunks during capture; update metadata, transcript and map atomically with each pending batch. Display success only after transaction completion; storage refusal/quota errors retain memory data, show a download/retry action and preserve navigation warnings. Reopened recordings are view/export copies; a new recording gets a new identifier. Browser eviction/cleared site data can still remove local copies, so downloading remains available.

Sign-in alone never uploads anything. Existing private file upload/list/open/download uses the signed-in identity across devices. Public library contribution is separate, explicitly confirmed and never a default. Existing provider consent, cloud limits, account isolation and publication removal rules remain unchanged. Ephemeral mode controls application conversation retention, not provider processing or browser-managed caches/session cookies.

Acceptance: real browser capture/pause/stop/reload/library reopen preserves audio and transcript/map; ephemeral conversation creates no IndexedDB conversation content; unavailable/quota/aborted writes cannot claim Saved; retries preserve chunks and newest snapshot; new conversations do not replace previous ones; cloud/public writes require their explicit controls.
