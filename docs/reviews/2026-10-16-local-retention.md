# Browser retention and compact controls — 16 October 2026

Outcome: unsigned-in recordings save audio chunks, transcript and generated map on this browser by default. More → Settings selects Ephemeral for subsequent recordings. Browse reopens local recordings, with explicit local removal. Sign-in alone never uploads; existing private saving and public contribution remain explicit actions.

Integration owner: root. Authoritative checkout: `/Users/aditya/.codex/worktrees/lct-inference-choice/live_conversational_threads`, branch `codex/lct-inference-choice`; controls base `d4e755b`. This receipt covers the exact file hashes below. Publication receipt follows after runtime verification.

## Behavior evidence

- Final full acceptance: 1022/1022 tests across 119 files, 2026-10-16 14:35 IST (7.16 s); focused storage/recording boundary 23/23 pass. Production client/Worker build passes. Existing large-bundle warning remains; no new build failure.
- Isolated actual-browser synthetic recording: after a real reload, transcript and map reopen, audio plays (2.008 seconds, readyState 4, no audio error). Stored 1 recording, 6 chunks, 11013 bytes. Two ephemeral recordings including generation left these counts unchanged. No microphone, paid provider, identity token or user conversation was used.
- Final real IndexedDB contract: 5/5 pass for exact audio bytes, corrupt-map recovery retaining audio/transcript, missing whole segment marked incomplete, stale-tab write refusal preserving newer transcript, and deletion resurrection refusal. Fixture creates/removes only its own synthetic ID on localhost:43226.
- Storage refusal remains visible, never displays Saved, retains in-memory transcript/audio and offers retry/download. Transaction acknowledgement waits for completion; committed-before-deadline event ordering has a public API regression. Empty MediaRecorder chunks are filtered before indexing/emission.
- Local replay → new Ephemeral recording route transition reproduced and fixed; after Stop the Start control remains usable. Local library open/reopen and desktop/320px navigation/settings/status controls inspected through the connected browser.
- Public/private destination behavior and cloud limits were not changed. Real-account private upload/reopen/delete/cross-device and second-account isolation still need acceptance. Direct Gemini funding and original custom-domain cutover remain separate dependencies. This is not full-migration acceptance.

## Independent review

Standing source-only egress authorization loaded from REVIEW_AUTHORIZATION.md; packets exclude credentials, private data, recordings, logs and unrelated files. Implementer family Codex; reviewer Anthropic Claude (`claude-opus-5-5`) using the existing authenticated account with tools, persistence and MCP disabled. Gemini returned no verdict and Grok timed out; neither counts as a pass.

1. Controls packet SHA256 `44d083574e15af8bdf3055ecd84dbbc8be5e194e397bad18a61c0eb4b97ac42f`: FAIL with seven observations, followed by supported repairs: busy capacity separate from exhausted; hover gap removed; per-request deadline; retained map panel plus completion notice; health refresh cannot clear unrelated error; cancellation not provider failure; client-receipt freshness clock.
2. Retention plus controls corrections, SHA256 `857ee5673e63659fd250d46e5ef05daffc2461dd5c499126442a0ad8e83806de`: PASS with three low observations. Fixed all: no empty failed-start archives; damaged-map recovery; transactional revision guard against stale overwrite/resurrection.
3. Storage correction SHA256 `2feab96826aa39f92534bcfc0577cca817d562469c8be7b6705c26474352bbbb`: PASS with observations. Fixed commit-acknowledgement deadline and absent-segment completeness. Empty-chunk observation disproved against the producer filter and strengthened callback regression.
4. Final bounded delta SHA256 `8a47b2d2f3b2016d35fbd20dcd1f43e96490873f3be66c2a1887f6fcbafa3b0c`, 37451 bytes: **PASS, zero findings**. Source-only limitation retained; actual-browser storage checks supply separate runtime evidence. Last browser fixture amendment adds the missing-part assertion without changing runtime code.

No account access, environment, quota, DNS or sharing mutation. Current public Site audience will be preserved.

## Exact validated files

- `lct_app/sites/serviceHealth.js` — `e56ea3fbaf5d80ccb7daf3c3752bdf02a7b4a5779a409b529b526d633b634f88`
- `lct_app/src/PrivateFiles.access.test.jsx` — `4007af903f763767ebc3a3df0ac02824bbd7c96a0ea0a34236e95716c2b2b3dd`
- `lct_app/src/components/SitesAccessPanel.jsx` — `407614dc3769db8decb8fdaec7529f9f56182724366544ea06ccfdedcf9e1c81`
- `lct_app/src/components/SitesAccessPanel.test.jsx` — `2c17253b51f8f5b3775671658acf540a433dde06ae7d0dd113214aa9b96dfdca`
- `lct_app/src/components/browse/RecordedConversations.jsx` — `d62431fa8baa9e686b946767f1d051a350c84ba86eed1440704d864edeb2848f`
- `lct_app/src/components/recording/ConversationNavigation.jsx` — `b723896edf52df02460ee8cca139f140d6195d5072c4548591f75277b3d1a8b9`
- `lct_app/src/components/recording/ConversationServiceStatus.jsx` — `c5d22d1f1171e7c686d0f350413e2cec7d4f72ba08ec394e9b2f07197c47c62c`
- `lct_app/src/components/recording/ConversationServiceStatus.test.jsx` — `17fdf2e9f09ed196c5036beb6445a5f7b4f6e624c8d6ab8395b710d5448f75c9`
- `lct_app/src/components/recording/ConversationStorage.jsx` — `a62f4937f2bdba2472fafc17d7ee30be0969d34a19c4cba34c7e2ab0fc586473`
- `lct_app/src/components/recording/RecordingAudioFiles.jsx` — `966030683e22e8812666cd94703abffb8e89e91424c80b1fcb66701f7304f973`
- `lct_app/src/components/recording/RecordingConsentDialog.jsx` — `d362a672099af5e71e497577446f6da318453cae840387530f68fa5f858197d8`
- `lct_app/src/components/recording/RecordingConversationMap.jsx` — `d6a6772f74cd2793f05ace43c7a9e242f43b40eeb35ffad789f2ce3bbc67b1f5`
- `lct_app/src/components/recording/RecordingTranscriptFiles.jsx` — `930095ec46490d525763be50b07fa424fc1734f76beb2e14fbe9eab4fd0e659d`
- `lct_app/src/hooks/useConversationArchive.js` — `ab4a0ad122860a57b96f5d8bdf8dbeb677220402c4cc690e23b339dd40312189`
- `lct_app/src/pages/Browse.jsx` — `cbbf19fe119bbefc92c9ea34c7d23cf13562ab01ce8bb35471e5be12f99e8525`
- `lct_app/src/pages/SitesNewConversation.jsx` — `b994cda5b196c6f73bd301f3db2bd2db452cc793af568f231d0927dc2187de3d`
- `lct_app/src/pages/SitesNewConversation.test.jsx` — `17be0baf413af7d3cd478392bad51262a5fc3299b74cd27bed0c571d908e97da`
- `lct_app/src/pages/SitesPrivacy.jsx` — `3daeca898a707e300eb0393c2c21e1be46fab446f69358cca05de1e1f3be3a63`
- `lct_app/src/services/cloud/cloudConversationSession.js` — `77f89f207997deca1c4b6b2ec844b23edf576f831a5d2ccde1c26e4cfdd769e7`
- `lct_app/src/services/cloud/conversationArchive.js` — `2b2cff5cff4834d1d194bb82d9523b8e1ea0ae74ac8c003c1141dbb6f0379e0e`
- `lct_app/src/services/cloud/conversationArchive.test.js` — `7d73be3948c7ba501555c50e3d00e920158936c16faf1135722be3efc79544be`
- `lct_app/src/services/cloud/conversationRetention.js` — `1543bf95900b6c555bcf3df1061b7f0a3e284a9511ca77cd8d930d324e872ef5`
- `lct_app/src/services/cloud/localConversationStore.js` — `7f8dad873d20ba0ed92602e1d5b12092a5da1d1b2260a7ad5bcf647e220a66a5`
- `lct_app/src/services/cloud/localConversationStore.test.js` — `adbb86d0c67fabbc387895197b1797c606f78a8436697047cd8c9df22def1eab`
- `lct_app/src/services/cloud/recordingSession.js` — `58cb2d6799a922c4b30d886d44fed9ae43b6976c6c5ac67b8ea981a9c61b4ae4`
- `lct_app/src/services/cloud/recordingSession.test.js` — `688997fd1431259476ca6717ac11d376566aaa03c412bd0394953edbaf0b9606`
- `lct_app/src/services/serverless/sitesServiceHealth.test.js` — `03d3162fa657ec858de53519303f7763e5258f9ad3d9edcdc4782a40401d725b`
- `tests/browser/local-conversation-contract.js` — `5c6a3a74faf5f2cd799b5fabc10bdd4bc72df1ef36b8bc592721a01428ec011f`
- `tests/intent/local-conversation-retention.md` — `2dbd1f94c8f5930f2d6f41e6d55259e7a2ff81520924dddc51463dd8437de9fb`

## Served receipt — 2026-10-16 14:46 IST

Application source1073338e0eaa78fb316b3eafe187cbff0ba18979 committed/pushed on the task branch; native Site source55c86b092d713f944340337e3cff3875a9d6a288 committed/pushed by the official Sites helper. Site43, versionappgprj_6abe98e1b1b08191b2b763a78e1da819~appgver_3c69916609888191b8fc49ebb130b989, deploymentappgdep_6ad1ea5647e481918286e0a64e57744f succeeded2026-10-16T09:12:24.557071UTC, public/env37. Archive39files/1925120bytes/SHA256718fe156d6eaaaf465879c4a660de139977e0a3384225b9cc040c61c8a4d761f. Fresh browser confirms exact served /assets/index-CpIG4c7O.js, default On this device, Ephemeral settings and compact controls. Screenshot /private/tmp/lct-retention-settings-live.png. No user recording tab was reloaded.

Live read-only check exposes Soniox Provider access was refused, while OpenRouter API check is reachable and live processing unverified. The new Soniox models probe refusal is not proof that existing temporary-key transcription is broken, nor proof of depleted balance. Request method/URL/header match the official GET models documentation. Exact upstream401vs403 and key permission cause remain unknown because this intentionally sanitized health endpoint groups them. Logged separately in ISSUES; do not widen credentials or spend merely to make a green indicator. Storage slice is delivered; real-account cloud cross-device acceptance remains unverified.
