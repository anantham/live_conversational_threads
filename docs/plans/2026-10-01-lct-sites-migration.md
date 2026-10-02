# LCT Sites migration — staged delivery

## Progress tracker — updated 2026-10-02 07:44 IST

**Current stage:** The [public parallel preview](https://threads-adityaarpitha-cloud.avalokai.chatgpt.site/) version14 is live. The user approved keeping signed-in private copies until deletion; a shared notice now explains retention and private visibility beside deliberate file/audio/transcript saves. Native normal/mobile checks verify the visible private-file notice and accessible button descriptions without overflow. Personal uploads remain synthetic-only and Soniox disabled. Guest entry and the actual optional ChatGPT session retain their verified behavior. Earlier native proof covers fixed nonpersonal private save/reload/map/Discussion reopening and the private viewer access notice at390px/320px. The independently approved pure source-to-generated-map export is included but not mounted and invokes no intelligent model. Public .threads publication still requires explicit whole-file consent; public visibility does not itself grant a public-domain copyright license. Actual second-account isolation, personal uploads/recordings, production capacity, provider funding, supported cloud inference and domain cutover remain open. The original threads.adityaarpitha.com deployment is unchanged.

**Planning estimate for the remaining core cloud beta:** **23–64 active engineering hours**, approximately **3–8 focused workdays** at eight active hours per day. This is a planning range, not a measured ETA or calendar-date promise; comparable integration timing history is insufficient. Pauses and waits for funding/activation decisions, platform eligibility, DNS or certificates are additional. Do not infer revised precision from the preview evidence.

The beta means a visitor can open the app without signing in, create and explore explicitly public shared conversations, or sign in with ChatGPT to save private audio/transcripts/graphs and browse personal history. Soniox recording, export/deletion, consent/retention, usage limits and recovery must work while the owner's computers are off. Public visibility is explicit at saving; browser-local files and private records are never published implicitly. Attendee meeting bots, old-recording migration and ChatGPT-subscription inference are tracked separately.

| Milestone | Status | Planning effort remaining | Completion evidence |
| --- | --- | --- | --- |
| 0. Sites Worker adapter | **Done** | — | Streaming proxy, runtime build and public-interface tests pass; AGY Gemini independent review PASS, no findings. |
| 1. Runnable parallel Site and optional sign-in | **Done at parallel URL** | — | Native deployment succeeded; real browser shows Signed in. Anonymous root/Browse200, refresh retains Browse, absent/forged/service identity401. Public shell has no old health/key gate; owner history is excluded. Both output guards, tests and independent review pass. |
| 2. Public and private storage | **Partially complete; synthetic reopening verified; manual retention approved and disclosed** | 8–24 active hours (retained conservative planning range) | Native anonymous write/retry/removal boundaries and browser consent/download/view/refresh/creator removal pass. Masked recovery details and narrow-screen controls pass; local key download remains unsupported in this preview browser. Private ready maps open in memory on the same route; native fixed-fixture save/reload/reopen/Discussion/view-only edits and narrow layout pass. Explicit saves now explain private copies remain until deletion; selecting a file or finishing capture sends no upload. Remaining: second actual-account isolation, real-upload activation, production abuse/usage controls and real recordings. Opening local files does not publish them; public viewing does not write personal/local history. |
| 3. Soniox live transcription | **In progress; inactive source and transcript companion deployed** | 4–10 active hours (retained conservative planning range) | Temporary-key admission, protocol/capture/finalization/failure and local transcript JSON/save controls have synthetic proof and Gemini approval. Native guest New/status/inactive503 and empty admission table pass. Remaining: approved audience/session/spending policy, verified provider project budget/residual overrun policy and authorized real microphone/provider/private transcript smoke. Single-use keys and connection caps bound issuance/time, not exact dollars. No automatic reconnect or billable retry. |
| 4. Cloud conversation intelligence and exploration | **Canonical transcript and generated-map export groundwork approved; inference/integration pending** | 6–16 active hours | The unused pure bridge packages supplied generated hierarchy/edges with exact source into bounded v2 .threads; real reader/Discussion tests and Gemini review pass. No model quality or generated journey is claimed. Remaining: approved supported cloud inference producer with source links, observable cancellable stages and deliberate public/private save; new intelligent maps save, reopen and render without private/Tailscale/local backend calls. |
| 5. Release checks and domain cutover | Planned | 5–14 active hours | Full signed-in journey passes with private-network access blocked, including cross-user denial, refresh/reopen, slow/failure/retry/cancel and narrow-screen checks. Each changed source slice has independent non-OpenAI approval. Controlled billable smoke stays within agreed limits. Verify custom domain/certificate and rollback before replacing the working deployment. |

The **23–64 active-hour / 3–8 focused-day** range is a planning estimate, not measured timing. Review and proportionate validation are included; external waits are additional. No percentage complete is assigned because the milestones differ substantially in size and risk.

### Next checkpoint

Approve and check a bounded Soniox policy before a real transcription smoke; the key remains unconfigured. In parallel, verify hosted ChatGPT-plan approval/supported credentials, test private isolation with a second actual signed-in account, and finish real-upload activation and production public controls. Manual retention and deliberate-save disclosure are settled; they do not activate real data. Integrate the source-auditable export with the approved extraction producer rather than wiring the legacy source-dropping/local-only pipeline directly to storage. Sign-in does not establish plan inference permission; the private synthetic fixture does not prove cross-account isolation. Hosted controls and synthetic capture/export tests are not real recording/transcription/model/save proof. Preview limits do not establish moderation, a production capacity policy or an exact monetary ceiling. Cloud intelligence and custom-domain cutover remain ahead; retain the unmeasured planning range until comparable runs justify a revision. Latest source checkpoint evidence: docs/reviews/2026-10-02-private-retention.md.

### Decisions and waits that affect the calendar

- Native Sites public access and actual owner sign-in are verified at the generated parallel URL. Verify a second signed-in account against private ownership during storage testing; custom-domain authentication remains a release/cutover gate.
- Choose the owner's global Soniox spending cap, per-user/session limits and the allowed audience before activation. Private copies remain until their user deletes them, as approved2026-10-02. The discovered local key is not yet configured as a server secret.
- Prefer the documented ChatGPT-plan text route where this hosted app is approved. If approval is unavailable, evaluate a supported API-key/BYOK fallback with the human; an owner-funded public API path requires an agreed spending cap. Do not silently treat sign-in or Codex OAuth as inference permission, or activate a paid fallback.
- Allow for non-OpenAI reviewer availability. AGY successfully reviewed the foundation through existing credits; approval of future diffs still needs an available eligible reviewer.
- Verify custom-domain support and the existing DNS control before cutover; keep the working deployment available for recovery.

### Private-storage activation brief — 2026-10-02, retention approved

Classification: reserved human judgment. The [storage ADR](../adr/2026-10-02-sites-private-files.md) requires a user-approved activation/retention policy before real uploads. Existing recovery is already implemented and reviewed; current source supports recovering complete staging or fenced deletion of unfinished bytes. The latest full suite passed19storage cases within665total; controlled SQLite/R2 tests are not a second actual-account check. No replacement reconciler is required.

Approved policy: keep deliberately uploaded private files until their signed-in owner deletes them. The human selected this policy2026-10-02. Existing private storage behaves this way; the disclosure adds no automatic publication, provider processing or expiry job. Current preview ceilings are2MiB/file,10MiB/account,20MiB/Site and200lifetime keys; this selection does not approve production capacity. These controls do not promise an exact monetary cap or production fairness. Download remains available; deletion removes stored bytes and retains only empty random-key fences. This is account access control, not a promise of encryption that excludes the Site operator or infrastructure provider.

Alternative considered:30-day automatic expiry requires a separately implemented/tested cleanup policy and clearer recovery warnings. The user chose manual owner deletion for durable private history; confidence0.9 about alignment with the requested storage. Prediction: existing save/read/recovery/delete behavior remains intact; fallback retain synthetic-only mode if privacy, storage or release checks fail. This is a one-time retention selection, not blanket approval of paid providers, public sharing, broad real-data activation or domain cutover.

Disclosure checkpoint complete at version14: file, recorded-audio and finalized-transcript saves share the approved notice and accessible descriptions; the real-file action says “Save file privately.” An explicit save is affirmative consent. Tests verify selection/capture alone causes no POST and explicit saves send the selected bytes. Native signed-in private-file layout passes normal/mobile checks; recording controls remain hidden while STT is inactive. Next: verify the second actual account and bounded real-file journey before concrete activation. Soniox funding and hosted-plan eligibility remain separate pending questions. The original domain and live environment stay unchanged while these gates are unresolved.

### Follow-on work

| Item | Status | Estimate / next evidence |
| --- | --- | --- |
| Hosted Attendee meeting bots | Deferred from core beta | Tentatively 2–5 additional focused workdays for a hosted-provider integration after provider/access selection. Self-hosting is not included in this range. Verify bot lifecycle, webhook identity, audio export and recovery before committing to a date. |
| ChatGPT-account-funded text intelligence | Eligibility-dependent | Calendar ETA unknown until the hosted application's supported access is confirmed. Measure implementation scope after approval. The documented plan flow excludes audio/transcription. |
| Existing recordings/history migration | Deferred | ETA unknown until an explicitly selected dataset, authorization and compatibility/export audit establish the scope. No private history has been inspected. |

### How progress will be maintained

During active migration work, update this tracker when a milestone starts, passes its completion gate, becomes blocked or changes the ETA. Each update will state the last completed gate, current work, next check, remaining effort range and any external wait. Keep an append-only note in `docs/WORKLOG.md` and link validation/review evidence. The latest estimate lives here; the earlier planning sections below preserve context.

For live/import UI waits, show the current stage and elapsed time; use measured history for remaining-time estimates and show "Time remaining unknown" when no credible estimate exists. Record bounded, payload-free timings and outcomes so later estimates can improve. This roadmap does not schedule unattended work or notifications.

## Objective and evidence

The public Threads domain should let visitors create and explore new conversations while the owner's computers are off. Existing owner recordings and history are outside the first migration slice.

On 2026-10-01 the public root returned HTTP 200 from Vercel. Its deployed script contains private Tailscale API/STT origins; a local browser confirmed the configured STT and intelligence routes currently run on the owner's machines. This establishes cloud frontend hosting but not computer-independent application behavior.

The code has a serverless audio-file pipeline and IndexedDB persistence. Live microphone recording still starts the Python WebSocket path: AudioInput calls useTranscriptSockets; the browser OpenAI realtime client is currently unused. Saved-conversation viewing also bypasses the provider for some reads. Do not label the current serverless mode a complete offline-backend replacement.

## First slice: runtime compatibility

Hypothesis H1: the existing Web Request/Response chat and realtime-token handlers can run in the Sites Worker runtime once environment access and request guards have explicit runtime inputs. Predicted result: synthetic Worker requests preserve streaming and failure behavior, and the production Worker bundle runs without a Node process global. Confidence: 0.9. Fallback: keep the existing Vercel handlers/deployment and revise the adapter from the failing public-interface test.

Implement only a BYOK Worker adapter, reusable Web handlers, and a standalone Worker build. Keep classic Vercel entrypoints working. Sites uses its exact request origin and trusted Cloudflare client-IP header. No owner trial credential is accepted by the initial adapter.

This slice introduces no Site registration, hosted data, runtime secrets, production restart, DNS change, or paid inference. It is a reviewable backend artifact, not a deployed or fully usable replacement Site.

## Subsequent slices

1. Connect browser live transcription and extraction, remove private-backend requirements from that public journey, and make newly saved graphs open in the browser. Explicitly explain unavailable owner-only capabilities. Verify with all private-network requests blocked and synthetic audio/inference.
2. Prepare a bounded Site source tree excluding environment files, owner data, private artifacts and operational history. Publish a private parallel Site, verify its complete core journey, then prepare the public audience/custom-domain cutover with recovery to the working deployment.
3. Add account-scoped cloud persistence only after defining identity, ownership, retention, export/deletion and recording consent. D1 can store metadata; R2 can store file bytes. Browser-local data remains browser-local until that feature is selected.
4. Add a computer-independent Attendee service. Its browser bots/Django workers need hosted Attendee or persistent VM/container hosting; they cannot be deployed as the Sites Worker. Provider selection and any new spend remain separate decisions. Verify recording export compatibility before selecting storage.
5. Evaluate Sign in with ChatGPT plan usage for text intelligence. Current official documentation supports eligible Responses requests, while a public remotely hosted app needs eligibility approval. The documented flow excludes audio input and transcription; use the selected Soniox path for STT. Never reuse the owner's Codex OAuth credentials for public visitors.

## Validation and boundaries

Independent review must cover the exact changed source, test intent and validation through a non-OpenAI authenticated reviewer. Only synthetic fixtures and bounded technical source may leave the checkout. Record the review result before declaring the source slice complete.

The first slice does not change user-visible asynchronous flows. Later live/import slices must reuse the shared status/timing presentation, use measured estimates, support unknown remaining time, and verify failure, retry and cancellation.

Primary references: https://learn.chatgpt.com/docs/sites; https://developers.openai.com/siwc/token-sharing-open-source; https://docs.attendee.dev/guides/realtimeaudio; https://github.com/attendee-labs/attendee.

## 2026-10-01 update: identity, private recordings and Soniox

The user wants each visitor to sign in and have private recordings associated with their identity. They offered their existing Soniox account for STT and are willing to fund usage from their own account when the supported product permits it. This is a direction for the next slice, not authorization for uncapped paid traffic or credential disclosure.

Sites has dispatch-owned ChatGPT sign-in: a signed-in request carries a stable Site-specific user ID. Use that managed identity and server-side authorization, preserving the platform-owned sign-in/callback routes. This does not require inventing an app-owned OAuth scaffold. It does not by itself grant access to a visitor's ChatGPT plan for inference.

Proposed storage boundary: D1 holds a recording's owner ID and metadata; R2 holds private audio bytes. Every list, upload, playback, transcript, graph, export and delete route must resolve the authenticated user and verify ownership. The client cannot supply or override the owner. Do not expose a public bucket or treat an opaque object name as authorization. Verify anonymous rejection and cross-user denial before connecting real recordings.

Soniox supports browser-to-provider live STT with server-issued temporary keys. Keep the long-lived account key in a server secret. After authenticating the visitor, issue a single-use short-lived transcription key with a bounded session duration and a pseudonymous usage reference. Set per-user quotas and an owner-approved global spending limit before enabling billable traffic. No Soniox credential or private billing report has been accessed.

OpenAI's generic website SIWC is a selected-partner trial; remotely hosted ChatGPT plan usage needs eligibility through the interest form. The documented plan flow explicitly excludes audio/video inputs and transcription. Eligible plan usage can supply text intelligence, while Soniox supplies STT. An owner-funded OpenAI API project is the supported alternative for public intelligence billing; do not treat existing Codex OAuth credentials as a public application key.

Recommended next slice: confirm the native Sites identity path for the intended audience/domain and prepare identity-scoped storage with synthetic data, then connect Soniox once funding limits and a server-side secret are configured. ChatGPT-plan intelligence remains eligibility-dependent; API-key intelligence stays available as the fallback. Confidence: 0.85 for this architecture; prediction: unauthenticated and other-user requests cannot access stored records, while the owner's validated session can list/read/delete them. If the platform identity path is unavailable for the intended audience, pause activation and choose a supported identity provider with the human.

References: the installed Sites authentication guidance at `skills/sites-building/references/authentication.md`; https://developers.openai.com/siwc/website; https://developers.openai.com/siwc/request-client-id; https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations; https://soniox.com/docs/guides/temporary-api-keys; https://soniox.com/docs/guides/direct-stream.

The user subsequently confirmed a preference for Soniox STT because of audio API cost. Use Soniox for the planned transcription path; do not substitute OpenAI audio billing without a new product decision. The first compatibility slice is locally validated and independently approved by Google Gemini 3.1 Pro through AGY; see ../reviews/2026-10-01-lct-sites-serverless.md. Native identity, private storage and Soniox integration remain subsequent slices; no Site or billable traffic has been activated.


## 2026-10-02 06:32 IST — Private reopening checkpoint

Version12/source1859f6c58c31e8a16492eeed463a4d121fb419f4/deploymentappgdep_6abf012e88b08191acae65f4df6b7cce succeeded00:56:44UTC/environment2. Fresh283-file sanitized export differed from clean version11 source only in the independently reviewed access panel; dependencies/migrations unchanged. Native owner fixed-fixture map/transcript reopening and view-only name reset pass, cookie-free private read401 and guest entry200. Private access notice is in document flow, with no horizontal overflow or final-passage intersection at390px/320px. See ../reviews/2026-10-02-private-conversation-reopening.md. No key/provider/paid/personal-data/schema/environment/domain activation. Keep the unmeasured23–64active-hour range and remaining activation gates; fixture proof is not real intelligent-conversation creation.

Preservation gate: implementationdbe09c3 and independently approved format92460de are pushed;634/634tests in92files passed33.43seconds (start06:34:12IST), all LCT gates green and exact committed review guards pass. Current milestone and unmeasured planning range remain as above. This checkpoint does not complete the full cloud beta.
