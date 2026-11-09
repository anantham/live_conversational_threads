# Cache-preserving dependency build — 17 October 2026

The original build failed at the official Zoom SDK wheel92.9/118.5MB with a PyPI
ReadTimeoutError after1640.7s. Base/Chrome/media layers remain available. Source
prepare_cached_build.ps1/cached-build.md introduce a new external recipe with only
the requirements pip RUN replaced: dedicated public BuildKit cache,120second read
timeout,one HTTP retry. Source/dependency text, TLS and upstream indices remain.
No new privileges, source edits, runtime credential or data volume. One new native
build task is bounded2hours; failure stops the method rather than auto-retry.

Independent Google/Gemini4ArgonMedium via existing AGY subscription; bounded public
source only, no runtime logs, identities, secrets or private artifacts. First
packet5348bytes/SHA256157d93ab61ebb8daf19ff39a175949bfa5b3d7bf8ea8c10eead8004377c12cc8;
conversationa28d9eae-4cc5-4813-a963-9ecb0c8fb60a PASS,36.957s. Added supported
external-context/absolute-path and exact-line guards. Final packet5472bytes/SHA256
c958176bb6cb48ef316798a3d2921d8c056e0ec998ccd5a7284abd8b1cd65c47;
conversationb18ef141-bff2-4210-ade2-5c39bf5c44cf PASS/no findings,19.910s,one turn.
Plan/read-only/no-tools request used; no exhaustive client isolation claim.

Actual Windows parser/preparation succeeds at exact upstream500168b. Receipt:
source Dockerfile715B0FB4D2056B093AA146E80B78F578C6B2496C4E44A43FAC4BE25212792A72;
derived recipeA01ABF92DFE803EAAEB9274F8DE4923250DFE895DB7928EC28829193C4B0391E;
requirements85FE4FFF222C8BF4D5EDC02D023B64D3BFF40FDEB9A2678D5B6FA0AB1C592F3E.
Exactly1line changed, built=false at constructor boundary. Limited interactive
build dispatched separately; no completed image/import/API/S3/Meet proof yet.
