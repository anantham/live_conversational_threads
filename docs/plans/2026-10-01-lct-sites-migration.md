# LCT Sites migration — staged delivery

## Progress tracker — updated 2026-10-01 22:45 IST

**Current stage:** Worker compatibility complete; managed Sites identity and a runnable parallel Site are next. Nothing has been deployed or connected to real recording data. Source and review evidence are pushed on `codex/lct-sites-serverless`.

**Tentative ETA for the core cloud beta:** 24–64 hours of remaining active engineering effort, or approximately **3–8 focused workdays** at eight active hours per day. This is a planning range based on the remaining integration work, not a measured forecast or a promise of a calendar date. Pauses between work sessions and waits for access, funding decisions, platform eligibility, DNS or certificates are additional. Reforecast after milestone 1 proves the real hosting and identity path; no comparable delivery timing history exists yet.

The beta means a visitor can sign in, record with Soniox, save private audio/transcripts/graphs, reopen and explore their own conversations, and export or delete them while the owner's computers are off. A consent/retention policy, usage limits and recovery behavior are part of that gate. Attendee meeting bots, old-recording migration and ChatGPT-subscription inference are tracked separately.

| Milestone | Status | Planning effort remaining | Completion evidence |
| --- | --- | --- | --- |
| 0. Sites Worker adapter | **Done** | — | Streaming proxy, runtime build and public-interface tests pass; AGY Gemini independent review PASS, no findings. |
| 1. Runnable parallel Site and sign-in | **Next** | 3–8 active hours | Complete frontend/Worker asset bundle runs at a private parallel URL. Verify managed identity and intended audience/custom-domain support; anonymous recording API requests fail. No credentials or owner history in the source package. |
| 2. Private recording storage | Planned | 6–16 active hours | D1 metadata and private R2 audio are associated with the trusted signed-in owner. Upload/list/playback/transcript/graph/export/delete enforce ownership. Anonymous and second-user access are denied. Consent, retention and deletion are defined and tested with synthetic data. |
| 3. Soniox live transcription | Planned | 4–10 active hours | Browser microphone streams using authenticated, bounded temporary keys. Long-lived key stays server-side; session duration, per-user quotas and global budget are enforced before real billable traffic. Stop, failure and reconnect paths are observable. |
| 4. Cloud conversation intelligence and exploration | Planned | 6–16 active hours | Text extraction uses a supported cloud inference route. New graphs/transcripts save, reopen and render from authorized cloud storage. The core journey makes no private/Tailscale/local backend calls. Live status, retry and cancellation work. |
| 5. Release checks and domain cutover | Planned | 5–14 active hours | Full signed-in journey passes with private-network access blocked, including cross-user denial, refresh/reopen, slow/failure/retry/cancel and narrow-screen checks. Each changed source slice has independent non-OpenAI approval. Controlled billable smoke stays within agreed limits. Verify custom domain/certificate and rollback before replacing the working deployment. |

These milestone ranges sum to 24–64 active hours; they overlap neither each other nor external waiting time. Review and proportionate validation are included. No percentage complete is assigned because the milestones differ substantially in size and risk.

### Next checkpoint

Finish milestone 1 first and show the parallel URL, verified sign-in behavior and any access constraints. Then replace the broad beta ETA with the evidence from that checkpoint. Prepare synthetic storage and transcription work while any external access decision is pending; do not activate paid public use before its limits are agreed.

### Decisions and waits that affect the calendar

- Confirm native Sites sign-in works for the intended public audience and custom domain in the actual deployment. This is unverified, not a confirmed failure. If it fails, present a supported identity/hosting alternative before changing architecture.
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
