# Selectable cloud inference — review and local acceptance

2026-10-15. Integration owner: root Codex, isolated Mac worktree based on 7d5ab77. User requested direct Gemini/OpenRouter selection and activation/E2E. No new Site, schema, dependency or budget-cap expansion.

Final review: Anthropic Claude Sonnet 5.5, direct existing Claude Code subscription, PASS with no supported P0/P1. Source packet SHA256: `4e25916f324a443c00ea2e733f36369bdff05a2e8b92ad4fc336cba38ed46dff`, 60,513 bytes. Code/synthetic tests only; no keys, operational logs, personal files, memory or real recordings. Tools/MCP disabled and fresh review directory/no-session-persistence used. First AGY/Gemini attempt timed out without a response; Grok oversized packet truncated, then its compact review remained stalled and was cancelled. Neither is counted as a verdict. Initial Claude review findings drove explicit Gemini wire allowlist, recipient readiness equality, bounded backend diagnostics, clear direct-Google data policy, and stronger shared-limit tests; revised source passed follow-up review.

Remaining reviewer observations: Google's current structured-output documentation explicitly supports nullable type arrays, enum, additionalProperties, minimum/maximum and minItems used by the schema (https://ai.google.dev/gemini-api/docs/structured-output). Gemini OpenAI compatibility documents structured outputs and bearer API-key authentication (https://ai.google.dev/gemini-api/docs/openai). Current stable direct model is gemini-3.5-flash-lite; existing OpenRouter google/gemini-2.5-flash-lite Google Vertex endpoint was present in the public catalog. 8192 output-token cap is retained. Gemini intentionally shares the OpenRouter-named audience/count/token settings. A live provider result remains required; a review or status flag is not that result. Reviewer suggestion to test outside admission was not followed.

Validation: 98 focused tests after corrections; mandatory scripts/ci_local.sh934/934 tests109files passed17:26:17IST (15.88s). Earlier two failures were proven jsdom25 versus Node24/26 fixture incompatibilities: Blob.text absent and AbortSignal branding. Test-only Node Blob and signal bridge fixes preserve real Worker/response behavior. Node26 tests run with --no-experimental-webstorage so jsdom owns storage. No production identity code was altered.

Actual built-browser synthetic fixture check passed desktop1280x900 and mobile390x844: record/transcribe controls, finalized transcript, Gemini-only request, refusal without retry, backend switch clears consent, no mobile horizontal overflow. Native build passed; 7application files change and304other tracked files/all11migration SQL files remain unchanged (311total files). Runtime Gemini, Google sign-in and private ownership are not proven by this intercepted local check.

Packet inventory:
- lct_app/sites/openRouter.js
- lct_app/sites/openRouterPolicy.js
- lct_app/src/services/cloud/openRouterClient.js
- lct_app/src/services/cloud/openRouterGeneration.js
- lct_app/src/services/serverless/sitesInferenceChoice.test.js
- lct_app/src/components/recording/RecordingConversationMap.jsx
- lct_app/src/pages/SitesPrivacy.jsx
- lct_app/src/pages/SitesPrivacy.test.jsx
- lct_app/src/services/cloud/openRouterClient.test.js
- lct_app/src/pages/SitesNewConversation.test.jsx
- lct_app/src/components/SitesAccessPanel.jsx
- lct_app/src/components/SitesAccessPanel.test.jsx
- lct_app/src/services/googleDriveThreads.test.js
