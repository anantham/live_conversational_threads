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
