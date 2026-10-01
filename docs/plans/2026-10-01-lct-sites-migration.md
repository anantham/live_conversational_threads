# LCT Sites migration — staged delivery

## Progress tracker — updated 2026-10-02 01:56 IST

**Current stage:** Milestone2 is in progress at the [public parallel preview](https://threads-adityaarpitha-cloud.avalokai.chatgpt.site/). Public entry and optional ChatGPT sign-in are verified. The optional private-file screen and reviewed upload recovery are deployed. In the actual signed-in browser, a fixed nonpersonal57-byte sample saved privately, survived refresh, downloaded exactly and was deleted; native cleanup confirms no remaining file records and one empty late-write fence. Anonymous/forged private requests return401; Home/Browse remain200. Only the fixed sample is accepted: personal files/provider usage remain inactive. Second real-account isolation, retention, release advisory review and anonymous public publishing remain required. Soniox, intelligence and custom-domain cutover are still ahead. Source/review evidence is preserved on `codex/lct-sites-serverless`.

**Tentative ETA for the core cloud beta:** **23–64 active engineering hours**, approximately **3–8 focused workdays** at eight active hours per day. This revised planning range removes the completed entry/identity work and expands storage for the user's anonymous-public publishing scope. It is not a measured forecast or a calendar-date promise; comparable integration timing history is still insufficient. Pauses and waits for funding/retention decisions, platform eligibility, DNS or certificates are additional. Reforecast after the synthetic public/private storage boundary is validated.

The beta means a visitor can open the app without signing in, create and explore explicitly public shared conversations, or sign in with ChatGPT to save private audio/transcripts/graphs and browse personal history. Soniox recording, export/deletion, consent/retention, usage limits and recovery must work while the owner's computers are off. Public visibility is explicit at saving; browser-local files and private records are never published implicitly. Attendee meeting bots, old-recording migration and ChatGPT-subscription inference are tracked separately.

| Milestone | Status | Planning effort remaining | Completion evidence |
| --- | --- | --- | --- |
| 0. Sites Worker adapter | **Done** | — | Streaming proxy, runtime build and public-interface tests pass; AGY Gemini independent review PASS, no findings. |
| 1. Runnable parallel Site and optional sign-in | **Done at parallel URL** | — | Native deployment succeeded; real browser shows Signed in. Anonymous root/Browse200, refresh retains Browse, absent/forged/service identity401. Public shell has no old health/key gate; owner history is excluded. Both output guards, tests and independent review pass. |
| 2. Public and private recording storage | **In progress; private synthetic journey verified** | 8–24 active hours; retain planning range until public/private boundary is complete | Native private sample save/refresh/download/delete and conditional late-write denial pass;32/32 scoped recovery/UI/export tests and AGY Gemini independent PASS. Remaining: second real-account isolation, retention/advisory/activation policy, guest-public confirmation/abuse/usage controls and public-only reads, then real recordings. Private and local files never become public implicitly. |
| 3. Soniox live transcription | Planned | 4–10 active hours | Browser microphone streams using authenticated, bounded temporary keys. Long-lived key stays server-side; session duration, per-user quotas and global budget are enforced before real billable traffic. Stop, failure and reconnect paths are observable. |
| 4. Cloud conversation intelligence and exploration | Planned | 6–16 active hours | Text extraction uses a supported cloud inference route. New graphs/transcripts save, reopen and render from authorized cloud storage. The core journey makes no private/Tailscale/local backend calls. Live status, retry and cancellation work. |
| 5. Release checks and domain cutover | Planned | 5–14 active hours | Full signed-in journey passes with private-network access blocked, including cross-user denial, refresh/reopen, slow/failure/retry/cancel and narrow-screen checks. Each changed source slice has independent non-OpenAI approval. Controlled billable smoke stays within agreed limits. Verify custom domain/certificate and rollback before replacing the working deployment. |

The remaining milestone ranges sum to23–64 active hours; the storage estimate provisionally allows2–8 hours beyond the earlier private-only6–16-hour allocation for guest publishing and its controls. These are engineering planning assumptions, not empirical timing results. Review and proportionate validation are included; external waits are additional. No percentage complete is assigned because the milestones differ substantially in size and risk.

### Next checkpoint

Add anonymous publishing with explicit public-save confirmation and bounded abuse/usage controls; expose only intentionally public conversations. Verify a second actual signed-in account cannot read/change the first account's files. The private API cannot publish local/private files. Agree retention and provider spending limits before real-data/billable activation. Existing dependency advisories need a scoped runtime/build review before release. The synthetic preview has a200-key lifetime creation cap including empty erasure fences; production capacity policy remains required. No automatic broad package upgrades were made.

### Decisions and waits that affect the calendar

- Native Sites public access and actual owner sign-in are verified at the generated parallel URL. Verify a second signed-in account against private ownership during storage testing; custom-domain authentication remains a release/cutover gate.
- Choose the owner's global Soniox spending cap, per-user/session limits, recording retention and the allowed audience before activation. The discovered local key is not yet configured as a server secret.
- Use the supported API-key/BYOK text inference path for the first beta. An owner-funded public API path needs an agreed spending cap; ChatGPT-plan usage must not hold up the first release while eligibility remains unresolved.
- Allow for non-OpenAI reviewer availability. AGY successfully reviewed the foundation through existing credits; approval of future diffs still needs an available eligible reviewer.
- Verify custom-domain support and the existing DNS control before cutover; keep the working deployment available for recovery.

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
