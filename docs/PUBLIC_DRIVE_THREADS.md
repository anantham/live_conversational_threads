# Public Drive conversation links

Owner-requested on 2026-09-06 for the public YouTube conversation preview.

Public link shape: `/view?driveFile=<file-id>&public=1`.
The file owner must first enable **Anyone with the link → Viewer** in Drive.
The flag selects an anonymous transport; it does not grant access or modify ACLs.
Ordinary `/view?driveFile=<file-id>` links retain the existing Google OAuth flow.

## Data boundary

The public opener automatically calls the same-origin `/api/public-drive`
serverless function. It makes exactly one credential-free request to Google's
public download endpoint for a validated opaque file ID. Caller cookies/tokens
are never forwarded, no owner credential is consulted, and redirects (including
Google sign-in) are refused. There is no private LCT/Asus backend dependency.
No application-level logging of file IDs, bytes, or requests is introduced;
hosting-provider access logs may still contain the requested URL/file ID.

The function enforces a 20-second deadline, 4-MiB streamed/decompressed byte cap,
an approximate per-isolate/IP request limit, no-store responses, and a .threads
v2 envelope filter. The browser then performs the canonical node/edge/media
validation before rendering or saving. It is not a generic URL or HTML proxy.
Malformed files, Google's download warning pages, and inaccessible files produce
explicit errors with retry or an optional link to the private Google opener.

As with existing Drive links, successful artifacts are remembered in the
browser. Revoking Drive sharing cannot erase previously downloaded copies.
The cloud host transports public artifact bytes in memory but does not persist
them. No OAuth configuration or Google API key is required for the public path.

## Local and deployment behavior

The Vite plugin invokes the same Web Request/Response handler before the private
Python `/api` proxy. Vercel has an explicit function rewrite before SPA fallback.
Larger files can still use local opening or the authenticated Drive loader;
the public cap deliberately stays below Vercel's response-body ceiling.

Tests cover credential omission, strict IDs, redirect refusal, size/deadline
limits, invalid content, public desktop/phone opening, and unchanged private
gate selection. Controlled tests do not establish real Drive sharing permission.

The owner enabled public viewing in Drive's UI. On 2026-09-06 the actual file
downloaded anonymously and matched the source artifact's SHA-256. Signed-out
Chromium checks at 390px and 1440px opened it without Google identity requests
or JavaScript errors. Desktop source selection used the existing Center control.
This is browser viewport testing, not a physical-phone or Safari certification.

The viewer-only release includes source playback and the source-only mobile
fallback. It excludes the unfinished YouTube import/backend pipeline. The
preview is a diarized source transcript, not a completed semantic map. Wide
desktop layouts can still require Center or timeline navigation to reach a
card; that existing framing limitation is recorded in ISSUES.md. Automatic
camera motion no longer changes legacy clustering tiers in a feedback loop.

Local release checks: 60 focused unit tests and 7 Chromium E2E tests passed;
the opt-in live YouTube test was skipped in this release run. Production build
passed with the existing large-bundle warning. Deployment remains a separate
step, subject to the independent review gate and post-deployment verification.

References:
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/guides/manage-sharing
- https://vercel.com/docs/functions/limitations
