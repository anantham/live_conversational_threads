# Public viewer exploration acceptance

Completed: 2026-10-02 12:07:17 UTC (17:37:17 IST)
Integration owner: Codex
Authoritative checkout: viewer-source-and-controls worktree
Public URL: https://threads.adityaarpitha.com/view?src=%2Fexperiments%2Foverlapping.threads
Served source: `970f49d637024e3a179ced3f2f47ec7af110bc08`
Production deployment: `6807963520`, success at12:04:56 UTC
Immutable deployment URL: https://lct-gdg9ny5yu-adityas-projects-9c03351d.vercel.app
Source release PRs:207,208,209

## Changed journey and evidence

| Acceptance | Evidence |
| --- | --- |
| Read details below app controls | Public1440x900 and390x900 pane bounds pass; title opens/closes Overview |
| Reach the lower timeline rows |14 authored threads plus unassigned lane; last label/dot0px center delta, normal click opens its detail |
| Follow a selected thread | Seven distinct moments reached through normal arrow keys; Back/Forward restores selection |
| Restore reading position | Both widths restore exactly160px; new regression models automatic183px incoming-content scroll before history push |
| Trace evidence to recording | Evidence cues4399s; native iframe Play advances actual video clock, native Pause stops it at both widths |
| Name speakers across views | Source/card/detail/Discussion labels update immediately and survive Back; reviewed download retains original full_transcript bytes |
| Keep the public reader isolated | Zero page errors, HTTP5xx, app backend requests or horizontal document overflow in the combined served run |

The actual public run took34 seconds, from12:06:43 to12:07:17 UTC. Its report
identifies the public origin and both widths. Public artifact SHA256:
`386ef09b3b517e061de1c6499080ec81216cc2f5c5e320ebc6225d40558b7d19`.
The owned local example has identical canonical data; its raw-byte difference is
CRLF only, and normalizedLF SHA equals the served artifact.

Relevant local coverage supplements the served journey: camera/hierarchy replay,
name edits outside history, forward-branch truncation, stale artifact refusal,
multiple memberships/chronology and Source loading/error/retry/cancellation. Final
hook4/4, six owned-server Chromium continuity journeys, full mandatory frontend
gate513/513 in84 files, scoped hook/test lint and production build pass. Earlier
combined viewer suite15/15 and separate real native playback2/2 remain valid for
unchanged flows. Production smoke workflow37004595816 passes9/9 at this exact
source. No mock is used as proof of native playback.

## Independent review

Google Gemini3.1 Pro High through AGY approved core source7354564 and phone
repair b4fe577, with no findings, rejected claims or unresolved arbitration.
The final PR heads add mechanical documentation only; reviewed source/test/intent
remained byte-identical. Exact hashes, exclusions, provider identity and zero-tool
receipts are recorded in the accompanying continuity, smoke and phone-history
review files. Reviewers did not rerun tests; runtime evidence is recorded here.

## Delivery state

Edited, committed, pushed, independently reviewed, merged, production-served and
accepted by the stated automated journeys. No remaining delivery dependency.
The existing milestone board reflects closure. Separate captured follow-ups:
Legend placement while a detail drawer is open, shorter topic labels and time
replay. No implementation choice or ETA is assigned to those follow-ups.

This receipt and final board/worklog updates change documentation only. They do
not change the served source or require another runtime release.
