# Existing Asus relay: final pilot connection decision

Recorded 2026-10-18 12:51 IST. Proposed reserved action; not yet applied.

## Boundary and concrete change

H1, reserved human judgment; grey area: no. docs/AUTONOMY_AND_AUTHORITY_POLICY.md reserves permission/access/deployment-scope expansion. The existing objective covers recovery and the bounded synthetic pilot, but a new internet-facing handler merits an explicit ruling.

Add only https://asus-strix-scar.tail4741ad.ts.net:10000/lct-meet to the already-enabled existing HTTPS Funnel, proxying to the recovered loopback API127.0.0.1:8088. Current10000 root proxy127.0.0.1:8788 and every other route remain. Current complete snapshot is preserved on Asus; SHA2561A9B2711C6EDF83C3AD6231612D4B4F1EA96E8E3F1C93B48BE1E2D68E9BA0289. No new account, public port, DNS change, subscription or hosting spend.

Store the existing new-project API key only as a server-side secret in the existing LCT Site, with the already selected Google owner, enabled flag and a15-minute join window; redeploy the unchanged saved Site46. No credential goes to the browser, source, review or console. The recorder API requires its project key; the Site additionally enforces the exact owner and same-origin writes. Recordings remain private. This adds a publicly reachable authentication boundary, not public recording access.

The already-approved worker-only sandbox profile is used for one bot, at most300seconds, in the approved empty room. No broader worker/security permission is requested here. Close new joins and stop the pilot worker after the test; retain authenticated retrieval through the app/relay for the owner's recording. Removing the new handler stops cloud retrieval without deleting data.

## Completed prerequisites

- Native full build exit0, image sha256:2233dbf37b30c290ced68cf38ca194cd54af26e23ed8f14a71e5105ad9e07ca3, clean upstream500168b, one changed dependency RUN, unchanged complete requirements.
- Actual imports/migrations/bootstrap and24non-recording schema/API/S3 checks pass: correct dedicated namespace/UID, captions+MP3/five-minute schema, real empty API/DB correspondence, wrong-key/guest refusal, exact private object HEAD/bytes/ranges and anonymous storage refusal. Bot count0; no worker/public route.
- Actual selected Google-owner session authenticated; correct Meet host Join now with AV permissions disabled. Operator guard refuses wrong origin/owner.
- Existing profile/provenance approval and successful earlier sandbox probe retained; exact overlay is staged for configuration validation.
- A verified31.087664-second synthetic clip is loaded and paused on a one-hour loopback-only player. A Chrome-tab-audio handoff can provide real remote Meet speech without ambient microphone capture.

## Risks, rollback and alternatives

Risk: the additional path is internet-facing; the app and Site authentication checks limit access. Asus availability, low free host memory and slow networking remain reliability limits; this is no production-soak guarantee. Existing capped provider allowance and one deliberate map request apply; no new purchase or automatic paid retry. Other services/data/holders remain preserved.

Rollback: stop only the pilot worker; close the Site join window; remove only /lct-meet from existing10000 configuration if needed, then compare every remaining route against the saved baseline. Do not reset Funnel, remove volumes, clear attempts or replace credentials. Keep recordings/receipts. The narrower alternative is to leave API private and defer the cloud E2E test.

Recommendation: approve the scoped connection and run the bounded test. Confidence0.90 after actual private API/storage acceptance; remaining uncertainty is real Meet/browser/audio behavior. If route/auth/identity checks fail, leave the bot unsent and preserve the result. No wider exposure, permission or automatic second bot.

## Finite evidence and forecast

Require actual protected-route JSON and guest refusal before sending the bot, then empty host room, admission/leave, incremental speaker-labelled captions, one source-linked map, viewer reconnect/independence, finalized playable private audio and cleanup. Exact-source review/release receipts remain required. Current integration owner/root and authoritative codex/lct-inference-choice worktree stay unchanged.

Remaining implementation/release mechanics5–15minutes after approval, then actual pilot/verification10–20minutes; human tab-audio handoff and network/runtime failures are additional unknown waits. Prior forecasts remain historical; native dependency build took about24minutes in this resumed slice. Google Cloud hosting remains deferred.

## Concrete CLI operations and last readiness check

After the reserved approval only, add the handler with:
```text
tailscale funnel --bg --yes --https=10000 --set-path=/lct-meet http://127.0.0.1:8088
```
Rollback only this mount with the same flags and `off`; compare the remaining configuration to the saved baseline. Never reset Funnel.
```text
tailscale funnel --bg --yes --https=10000 --set-path=/lct-meet off
```
The installed CLI help confirms the flags; [official Funnel CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/funnel) specifies path-scoped `off` with original flags.

Actual approved overlay/config validation passes with credential bytes unchanged and no worker holder. The guarded host join first refused a tab that had returned to Meet home; the visible approved-room join flow restored prejoin identity/AV checks, then real room entry reports first participant/People1. No bot or notes/transcription started. Current host is waiting; synthetic tab is readyState4,31.087664s,paused. The connection decision and manual tab-audio handoff are pending.
