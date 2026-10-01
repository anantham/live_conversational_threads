# LCT Sites migration — staged delivery

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

The user subsequently confirmed a preference for Soniox STT because of audio API cost. Use Soniox for the planned transcription path; do not substitute OpenAI audio billing without a new product decision. The first compatibility slice remains locally validated but blocked on independent review; see ../reviews/2026-10-01-lct-sites-serverless.md.
