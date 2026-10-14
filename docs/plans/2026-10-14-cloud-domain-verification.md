# LCT cloud domain: registration and verification preparation

Recorded 2026-10-14, 20:49 IST. Integration owner: root. Authoritative checkout:
`C:/Users/adity/.codex/worktrees/lct-sites-serverless/live_conversational_threads`,
branch `codex/lct-sites-serverless`, base `7a6f8ca4abc90280c404f947c826bfa2e8a360bd`.

## Delivered scope and authority

Aditya approved only registering `threads.adityaarpitha.com` on the existing
cloud Site to obtain DNS and certificate requirements. Native owner preflight
and an empty custom-domain list preceded the single registration call.
Registration `appgdom_6acf9d15c6d481918c80105c8ff304a1` belongs to Site
`appgprj_6abe98e1b1b08191b2b763a78e1da819`. Independent list readback confirms
the literal hostname and binding. Refresh reports provider `pending` and SSL
`pending_validation`; this does not prove ownership verification, certificate
issuance, traffic cutover or the complete user journey.

The provider returned CNAME target `custom-domains.chatgpt.site.` and two
complete TXT records. Verification values stay in the native response; retrieve
them again immediately before any separately approved DNS action. A later
refresh also contains a null record placeholder: it is not an actionable record.

## Proposed next slice: TXT verification only, not yet authorized

| Vercel zone-relative name | Type | TTL | Value source |
| --- | --- | --- | --- |
| `_openai-site-verification.threads` | TXT | 60 | Exact current complete Site validation record for this hostname |
| `_cf-custom-hostname.threads` | TXT | 60 | Exact current complete Site validation record for this hostname |

Before requesting action, review this procedure and establish an authenticated
individual-record creation route. Before writing, obtain explicit authority for
exactly these two verification records. Re-read the same Site binding and the
entire Vercel zone in team `team_0bt8qOWPo2k6Qf0nDXJOE9dE`; refuse a hostname,
team, value or conflicting-record mismatch. If an exact record already exists,
retain it instead of duplicating it. Use only complete matching provider records;
ignore null placeholders. Additional or changed records require a new ruling.

Create records individually and retain each returned record ID. On an observation
timeout, reconcile that exact name/type/value against current records before
retrying; a timeout never establishes that the write failed. After each write,
verify readback and preservation of every preexisting record's name, type, value,
TTL and comment. Stop on unexpected changes. Do not use whole-zone replacement.

The authenticated owner read identified Vercel nameservers and eight existing
records. No explicit `threads` or its verification records existed. Existing
wildcard `*` ALIAS points to `cname.vercel-dns-017.com.` (TTL 60); preserve it,
the apex, CAA and unrelated epistack records. This is a control-plane baseline,
not proof of current HTTP behavior or a permanent provider-managed target.

After an approved write, query the exact TXT names at both authoritative
nameservers and refresh the existing Site domain handle. Report actual stages,
elapsed time, returned states and errors. Remaining time is unknown until
comparable evidence exists. TXT propagation/ownership and SSL readiness are
separate checks; two TXT records do not guarantee an issued certificate. If
verification is prolonged, stop bounded polling and retain the same handle.

Rollback, if separately authorized, removes only record IDs created by this
slice after confirming their name/type/value identity; preexisting exact matches
are never rollback targets. Partial success is retained and reported rather than
deleting unrelated state or automatically retrying.

## Execution route and later cutover

The current connector exposes record updates and whole-zone replacement, but
no individual create tool. No Vercel CLI was found on PATH. The live official
OpenAPI documents individual POST `/v2/domains/{domain}/records`; using it still
requires an approved authenticated transport. The Vercel dashboard currently
requires sign-in. Its WebMCP plugin action only opened a public plugin page;
it did not open authenticated DNS controls or establish additional access.
Do not extract authentication cookies/tokens, install a CLI or expand permissions
to manufacture a route. A normal signed-in dashboard or human manual record
creation is a possible route; neither has yet been demonstrated for this slice.

The CNAME traffic change is outside the registration/TXT preparation scope.
Before a later explicit cutover ruling, prepare the exact new `threads` CNAME,
verified certificate/routing conditions, Google origin/session checks, public
guest/private isolation acceptance and rollback by removing only the new explicit
`threads` record to restore wildcard inheritance. Preserve the existing Vercel
project alias and all unrelated DNS. Do not cut over solely because registration
or local tests pass. OpenRouter, actual microphone, Google two-account/private
storage and public persistence acceptance remain required for the full goal.

## Acceptance and next checkpoint

Registration acceptance: exact owner/hostname/Site binding, retained returned
ID, independent native list readback and explicit pending SSL state. These pass.
No DNS mutation, paid request, new key, identity activation or source deployment
occurred. Application code is unchanged; existing tests/reviews are reused rather
than presenting another local test run as evidence of DNS or HTTPS acceptance.

Next evidence: reviewed TXT procedure plus an authenticated narrow route and its
specific human ruling, then authoritative TXT/readback and provider verification.
TXT execution effort and account/provider waiting remain unknown; full-goal ETA
remains unestimated. Original-domain service is not counted as cloud-delivered.
