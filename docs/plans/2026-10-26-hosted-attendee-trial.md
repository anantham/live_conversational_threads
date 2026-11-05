# Hosted Attendee trial — provider proof before LCT adapter

Owner/integration: root, existing codex/lct-inference-choice worktree. User selects
small hosted Attendee trial on26 October. Same Site/domain/data retained; Asus
access methods remain stopped, no new VM/relay, production join window closed.

## Outcome and scope

One clearly named synthetic bot in the existing approved empty Workspace room,
maximum180 seconds with60-second admission timeouts, native English Meet captions
and MP3 recording. No purchase/payment method/upgrade, paid STT key, voice agent,
new map call or automatic replacement bot. Hosted dashboard currently confirms
five free hours and zero bots/API keys. These are real preconditions, not mocks.

This slice proves hosted capture and local artifact retrieval; it is NOT the
full LCT guest journey or a production recorder swap. Hosted API has no existing
custom /snapshot, /audio or /audio-chunks routes. After positive provider proof,
the LCT adapter/live-audio bridge is the next coherent slice; do not present this
trial as live threads, browser-local reload or computer-independent LCT delivery.
The old Asus one-bot/map allowance is not silently spent on another route.

## Safe preparation and predictions

Hypothesis H1: hosted runtime removes local host/access failures; native captions
and MP3 work together (confidence0.75; live proof pending). Alternative: hosted
capture/configuration still fails. Predict two distinct nonempty transcript
snapshots and a finalized playable MP3. Zero/unchanging text, wrong recording
format, missing audio or an unsuccessful terminal state fails acceptance.
Fallback: retain synthetic artifacts and stop; no replacement bot, credential
widening, paid transcription switch or automatic retry.

Official API create schema inspected in its rendered documentation: explicit
max_uptime_seconds, waiting-room and wait-for-host limits; MP3 format;
meeting_closed_captions with google_meet_language. List API uses cursor
results/next. Transcript API returns the current utterance list during a call;
recording endpoint returns a short-lived S3 URL. The URL is never logged.

Direct client attendee_stack/hosted_trial/trial.py uses only documented API
paths and HTTPS app.attendee.dev, no environment proxy or redirects. Credentials
enter through hidden getpass only, no command argument/env/file/reviewer. Media
uses a separate unauthenticated request restricted to the exact documented S3
host and MP3 path, bounded20MiB. New private output root and exclusive durable
create marker precede dispatch. Empty-project preflight, single create and
server180-second cap; normal leave around145seconds, bounded finalization reads.
Uncertain create is never repeated, including malformed responses. Unknown bot
relies on the request's server limit; manual dashboard reconciliation precedes
any future action. No bot deletion or historical-data mutation.

Before START: free allowance reconfirmed, no billing changes, known room visibly
empty/owned by chosen Workspace host, mic/camera off, only31-second synthetic tab
shared with tab audio and paused. Bot named LCT synthetic trial — captions and
audio. Admit it, play clip once after capture starts. No personal conversation.
Verify actual transcript progress and playable/non-silent audio, preserve original
MP3/transcript locally, leave/terminal state and remaining allowance. LCT thread
and IndexedDB acceptance are explicitly pending.

## Retention and credential boundary

Hosted policy currently says audio/video retained5days, transcripts/participant
data indefinitely by default; deletion request deletes media immediately and
transcript/participant data after30days. Use synthetic content only. No deletion
is performed by this client. No claim that local saving prevents cloud buffering.

Dashboard key-generation dialog is prepared with a dedicated trial name, not
submitted. Creating that credential needs action-time confirmation under the
computer-use security rule; trial selection already supplies product/host scope.
Do not ask for the hosted-provider decision again. Do not put a key in the
embedded browser API client: Scalar's web client can default to an external proxy.
Computer Use refuses Terminal.app access. Use one user credential-entry handoff
for the direct client, with --wait-for-start: hidden key entry and preflight only.
The client writes a preflight receipt and waits up to ten minutes for START in
its new private run root. The agent writes that marker only after fresh empty-host
and synthetic-sharing proof; expiry exits without a bot. No credentials enter
chat, disk or the browser API client. This uses the public client input boundary,
not a workaround of the blocked Terminal control. No terminal UI automation.

## Finite checks and next checkpoint

Isolated public-interface tests before review; exact Google/Gemini independent
review of source/intent/plan with all credentials, account IDs, actual meeting URLs,
media, transcripts and raw artifacts excluded. Findings resolved before live use.
No large Site suite/build/publication is required for this isolated client.
Next evidence: reviewed client and action-time key step, then real one-bot provider
proof. Active engineering forecast20–40minutes after credential/host readiness;
provider/browser/Google verification waits and capture repair effort unknown.
Earlier Asus forecasts remain missed because of recorded engine/transport failures.

Sources: https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots ;
https://docs.attendee.dev/api-reference/tag/bots/get/api/v1/bots ;
https://docs.attendee.dev/api-reference/tag/bots/get/api/v1/bots/object_id/transcript ;
https://docs.attendee.dev/api-reference/tag/bots/get/api/v1/bots/object_id/recording ;
https://attendee.dev/privacy_policy ; https://attendee.dev/pricing ;
https://scalar.com/resources/changelog/api-client .


## 26 October input-handoff correction

The first provider authentication preflight returned401; subsequent user-supplied
Terminal output reports local input refusal, before API or root mutation. Current
clipboard shape passes the unchanged printable-ASCII20-512 rule, but this does
not establish past prompt contents. User confirms Command+V; no Control+V cause
is inferred. The first run root stays preserved and must not be reused.

The handoff ordering was fragile: copy a command first, open the hidden prompt,
then copy the actual key value last and paste privately. Never ask the user to
copy another command after the secret, or close a one-time key display before
authentication succeeds. Existing key names do not reveal their secret value;
no additional key creation, deletion or rotation is authorized by an input error.
Computer-use Terminal denial remains binding; no alternate UI/clipboard-to-shell
route. Stop blind entry retries and use precise local refusal evidence first.

Client input diagnostics now distinguish empty/text type, control/non-ASCII,
spaces and invalid length without echoing input or stripping characters. Accepted
values are unchanged. Occupied roots and absent parent folders refuse before
asking for any secret; constructor's exclusive root/create safeguards remain.
New synthetic tests cover these public errors, unchanged valid boundaries and
real CLI preservation/refusal before the hidden prompt. No live input/API test
or replacement bot is performed by these regressions.


## Alternative requested — Site server-secret connection (proposed, not selected)

Read-only verification confirms existing Site59 remains active/public/owner at
its custom domain, environment revision70 unchanged. Installed Sites identity
and secrets reference supports server-only runtime values and HTTP external
connections. Secret values in native reads are redacted; do not infer missing
credentials from those omitted values. No environment/source/deployment mutation.

Proposed replacement for Terminal credential entry: user enters a hosted key
once in this existing Site's server secrets under LCT_HOSTED_ATTENDEE_API_KEY;
leave the separate Asus LCT_ATTENDEE_API_KEY unchanged. Implement/review a small
hosted provider adapter using fixed app.attendee.dev endpoints and the existing
owner/consent/idempotency boundaries. Keep joins closed until readiness; first
use remains the same one synthetic <=180second provider pilot with no purchase,
paid STT/map, replacement bot or automatic retry. Attendee runs the bot; Site
routes authenticate/poll/download over HTTP, with keys absent from client code.
Native-caption/MP3 capture and local retrieval still require real proof. Later
live threads/guest browser persistence remain separate acceptance gates.

This is a different credential destination and requires a Site source deployment;
setting a key alone cannot connect the current Asus-only snapshot/audio routes.
Present it as an alternative for the user to select, not authority inferred from
asking what other ways exist. Rollback disables the hosted path and keeps prior
Site data/Asus settings. No new Site, VM, billing upgrade or Google Cloud host.


## Selected continuation: existing Site route

User explicitly adopts the proposed server-secret route. Root owns the same
integration checkout and official native source. Add an owner-only /meeting-trial
page and /api/cloud/hosted-trial HTTP controller. A separate schema-only singleton
receipt holds exactly one lifetime attempt, leaving the old Asus table/holders
unchanged. Existing LCT_MEETINGS_OWNER is the authorized account; new server key,
fixed approved room and admission deadline are independent of the old relay.

Fresh remote empty-project read precedes atomic reservation and one create;
uncertainty remains reserved, with original-dedup GET reconciliation only. Server
180second cap, native captions, MP3 and no debug recording/paid STT. Reads and
one durable leave attempt remain available after admission closes. Signed media
is pinned to the documented host, bounded20MiB and fetched without API auth. No
key/URL/body is logged. Browser receives captions and its own audio proxy only.
No automatic join, replacement bot, media playback, map or public publication.
Full guest/live-thread/browser persistence acceptance remains deferred.

The user enters LCT_HOSTED_ATTENDEE_API_KEY in existing Site secrets; no native
ChatGPT/Terminal UI automation is permitted. Native Sites tools support server
configuration, but they do not reveal the provider's one-time key. No new key or
rotation inferred. Implement/refuse/review/build before enabling the one pilot;
verify all old data and default-off posture at deployment and shutdown.


## 26 October09:30IST checkpoint — reviewed default-off Site deployed

Implementation5072b4a is pushed, exact Google review PASS, final mandatory1236/1236checks and client/Worker build pass. Nativebf8e898/version60/env71 succeeded09:18:58IST; actual custom-domain page and owner Google session verified. All seven prior tables retained, new singleton empty. Hosted key name absent, admissionOFF, no deadline/provider check/bot/STT/map. Prior CLI method remains stopped. Only private Site-secret entry is pending; use same saved60 for environment application, positive closed-gate key/empty-project check, then fresh host readiness and same one180second pilot. No new key, purchase, general guest activation or provider capture claim. Exact evidence and recovered tooling mistakes: docs/reviews/2026-10-26-hosted-attendee-site.md. Forecast15–30active pilot minutes after credential/host readiness; external waits/new defects unknown.


## New-room request — evening26October

User selects a new Meet room; only normalized fixed-room secret changes, SHA256661620244833768cebdaa8a9cf95891c39ba34411879bedc6615f5025adf48fd. Environment72/same saved60 deployment succeeds. Key-name remains absent/admissionOFF/new table0rows. Pre-join shows an active Workspace call, so empty synthetic readiness is not satisfied; do not transfer/record that conversation or infer participant consent. Pre-join microphone input is rejected by automatic approval and not retried. One180second allowance unused. Private key handoff and genuinely empty room readiness remain prerequisites; all privacy/cost/no-replacement boundaries persist.


## 27October — Hosted secret saved; runtime value not yet valid

Exact supported web settings opened and user privately saved key (native73/is_secrettrue). LCT Google owner sign-in restored. Reviewed source057343e/native7ff40d2a/configuration diagnostic served61/env73 after1242tests/build/GooglePASS. Actual runtime key predicate fails; owner/room pass. No raw key or readback, provider request, bot, paid STT/map or reservation. Chrome extension UI blocks Replace before input; user handoff asks dismiss/correct or report lost value. No new credential/rotation. Keep same180second allowance unused, no actual remaining-balance/empty-provider-project or fresh room readiness claim. Exact receipts in docs/reviews/2026-10-27-hosted-configuration.md.


## Refined27October checkpoint

Same hosted allowance unused. Reviewed refinement0b16467/nativef52e9e7 served62/env73,1248tests/build/GooglePASS. Owner status now identifies runtime key length outside retained20–512 range; unavailable/empty/whitespace branches are disconfirmed, exact value/length/source unknown. Published upstream ApiKey.create uses32characters, accepted by this validator. No provider call or key recovery/readback/normalization. Current private correction is justified by field evidence after Chrome extension dismissal; if original value lost, reserve the new-credential decision. Keep admissionOFF until authenticated empty-project/allowance/fresh empty synthetic-host gates pass. Exact receipts in docs/reviews/2026-10-27-hosted-configuration.md.
