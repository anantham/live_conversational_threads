# Prepare OpenRouter generation without identity or provider activation

2026-10-03 21:55 IST. Status: bounded implementation inside the selected OpenRouter cloud migration. Real inference, model/provider choice, credentials, funding and hosted activation remain separate.

## Intent and authority

The user explicitly asked to continue work that does not depend on the pending Google/browser steps. The existing approved direction is OpenRouter text intelligence plus Soniox audio transcription. A pure request/response adapter can remove integration work now while retaining those activation decisions. The current public Site stays version16 with test-only private storage and paid providers inactive.

Root owns integration in C:/Users/adity/.codex/worktrees/lct-sites-serverless/live_conversational_threads, branch codex/lct-sites-serverless. A bounded implementation helper owns only new OpenRouter generation service/schema/tests/intent paths. Peer AGENTS.md and deploy-checkout dirty work are excluded.

## Decision

Prepare a side-effect-free OpenRouter nonstreaming structured-output contract. A caller must supply an explicit model and output-token bound; there is no default model, key, network, persistence, provider fallback or active route. Normalize recording source with the existing createRecordingTranscript API before building a request. Pass only necessary canonical utterance fields to the model, excluding account IDs, audio, recording identifiers and uncontrolled source properties. Treat source text as untrusted evidence, not instructions. Strict structured output describes the existing generated semantic graph contract, and no production fixture graph is substituted for inference.

Accept only a successful completed nonstreaming response with one usable choice and JSON graph content. Reject provider errors, refusals, truncation, malformed/oversized content and invalid source/hierarchy/edge references before producing an artifact. Delegate source authority and supported graph projection to the existing createRecordingThreads bridge, then use its unchanged portable file format and actual reader/Discussion consumer in tests. Keep exact original words, source speakers/times and completeness authoritative. Structural validity does not prove semantic correctness or actual model quality.

The existing OpenAI-oriented SSE client accepts trailing frames without a completion marker intentionally; it remains unchanged. This new nonstreaming contract avoids changing its accepted behavior or its existing test oracle. A future asynchronous producer must add explicit processing consent, bounded cost admission, real provider checks, cancellation/retry/timeout status and deliberate saving; this pure adapter adds no observable wait to product UI.

## Hypothesis and acceptance

Hypothesis: provider-specific request/response preparation can be verified before identity access or funded inference exists. Prediction: complete synthetic OpenRouter output yields an artifact that the actual file reader and Discussion model can reopen with exact evidence; malformed/incomplete responses produce no artifact. Invalid source/model/token limits fail before request preparation. Confidence0.85. Fallback: keep the adapter unwired and preserve existing transcript downloads until supported findings are fixed.

Finite acceptance: source/response fixture readiness; explicit-model strict-JSON request with bounded source projection; complete synthetic graph-to-reader round trip preserving all tiers and exact evidence; provider error/truncation/refusal/malformed/oversized/unknown-source rejection; no source mutation, network, credentials or storage effects. Run focused and adjacent tests, lint, required combined push gate and one read-only independent non-OpenAI review of the exact coherent diff. Detailed checks are in the test intent before implementation.

## Remaining dependencies

The adapter is preparatory source, not a hosted intelligent conversation journey. Model/provider/privacy choices, owner-funded key and spending/admission limits, active Worker route, cancellable generation UI and deliberate public/private save must follow. Google activation and real-account private isolation remain pending independently. No added dependency, database migration, identity/retention change or deployment is selected by this slice.

## Primary references inspected 2026-10-03

- https://openrouter.ai/docs/api_reference/overview — explicit model, nonstreaming choice content, completion status and strict response format.
- https://openrouter.ai/docs/guides/features/structured-outputs — strict JSON schema and compatible provider parameters.
- https://openrouter.ai/docs/api_reference/errors-and-debugging — response/provider errors are failures rather than artifact content.
- Existing docs/adr/2026-10-02-recording-threads-bridge.md — source-owned hierarchy/evidence/edge validation.
