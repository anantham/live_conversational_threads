# Meet occurrence sources and transcript review

Base: `0d4285eb89f2c2fab98287cb0f5d4994a06ba1ee`. Source-only change; no runtime activation, bot policy change, deployment, production database access, or external delivery.

Exact authenticated Calendar occurrence metadata is retained through Attendee joins and session persistence. The read-only retained-source API returns immutable original caption events only when identity is verified; caption-relative timing never asserts an offset into Drive audio. Legacy URL/time associations remain unverified.

Saved owner conversations gain Graph and Transcript views sharing the original audio association. Word seeking uses existing matching alignment; other passages seek by segment, and caption-relative or missing audio is explicit. Corrections atomically update existing Utterance and EditsLog with expected-text CAS, clear stale word timings, preserve original TranscriptEvent, and mark graph-derived text for refresh. LCT corrections and TC Meet Review remain separate until an explicit cross-product revision contract exists.

## Validation

- 83 synthetic backend tests passed: transcript review, retained source, existing Attendee bridge, join API and helpers. Temporary SQLite validates observable transaction behavior; no live PostgreSQL integration claim. Existing Python 3.9 warnings and pytest old temporary-directory cleanup PermissionError after exit0 were observed.
- 12 frontend tests passed: 10 transcript component cases, progressive page loading, and bearer-token/CAS transport. Scoped new-module ESLint passed. Vite production build passed (2314 modules; existing large-chunk warning).
- Synthetic intercepted browser at desktop1366x900 and mobile390x844 verified word seek4.028775s preserved across view switches, correction save, no horizontal overflow and no page errors. No real recording or participant data. This is synthetic proof, not deployed UI proof.
- Fresh Astra visual review found repeated Edit reset an unsaved draft; fixed by guarding/disabling reentry and a public click regression.

## Independent review

Google Gemini3.1Pro reviewed the exact source diff, test intent and validation read-only with no tool calls. Final verdict: **APPROVED; no actionable P0-P2 findings remain**. An initial authentication finding assumed cookie/JWT sessions; actual existing bearer transport, single-owner context, middleware and an added public transport regression disproved that premise. Reviewer accepted the counterevidence; no unresolved overclaim. Final packet SHA256: `ae6177d575d7c07b86ea4712ff9aabe0a44f24b9de85e630e5c9ef8ff38b57cd`.

## Reviewed source manifest

Hashes refer to reviewed working-tree bytes; Git may normalize line endings on checkout. Operational worklogs, private fixtures, screenshots, build output and temporary review packets are excluded.

| Path | SHA256 |
| --- | --- |
| `lct_app/src/pages/ViewConversation.jsx` | `f1694f66d94a1542c00f7294c3c8817d7492c2f56761bcd503a1385f273b11c9` |
| `lct_python_backend/attendee_api.py` | `75cba4889fb496dca4c0ba09f4042f06000adf6fb79756e1be79ede77579e55e` |
| `lct_python_backend/conversations_api.py` | `57ed9441c9bdb1e3a3636c7d1a7362e9545f1654ce72586e428c572f4f5ce766` |
| `lct_python_backend/services/attendee_bridge.py` | `581a393284cd4ebf3da21cd3d571f539ed93014bb290865c6358e7b4e63dd6a9` |
| `lct_python_backend/tests/unit/test_attendee_api_join.py` | `543b34d3a91752377218531352fcd4d29c419009ecd34896dd03f0549ed27662` |
| `lct_app/src/components/transcript/TranscriptReview.jsx` | `a9d7a6362ab1830f899d6a2c87f3b31ba78d5a7bc981dda822aea178d3bc3f6a` |
| `lct_app/src/components/transcript/TranscriptReview.test.jsx` | `d510ca9b22e9eea8036d23b0d55cccd254630e1a25832fe45dc79ac0efd14bcf` |
| `lct_app/src/components/transcript/TranscriptReviewRow.jsx` | `4e57da8feba971e113a91bce533ea9d45af063922c94e6ccf431636dfc4eebb6` |
| `lct_app/src/components/transcript/transcriptReviewTiming.js` | `647f101b22c2fca5e1eadd59d38e11c2a8dd647cfd9615f59d98864bf11ff03a` |
| `lct_app/src/components/transcript/useTranscriptReview.js` | `d8754effd2c776f550e9aa91496c71fa4fed41e193f4cce0abb773bee7e3fd25` |
| `lct_app/src/services/transcriptReviewApi.js` | `b4d55348eb5b42a6f1010b364f8abd018b7fdc1849864ef74fb8cb3e00ecb52c` |
| `lct_python_backend/attendee_source_api.py` | `ba939bf017a71395795251af2c69f28e81d2e7a45aa0748124a4daa6329a85f7` |
| `lct_python_backend/services/attendee_identity.py` | `e7853225567923575f9293d4bc100dcc8b89bfba15135db66d8b4022e59ffb85` |
| `lct_python_backend/services/attendee_retained_source.py` | `b9e734b827c8e3845d1c4239eec8afdc476e76cb105083a725062c5d0d611aa1` |
| `lct_python_backend/services/transcript_review.py` | `4a26dc14eb8b274b0469b3bad4f3497461f37e21f195ca09625450b238e4943a` |
| `lct_python_backend/transcript_review_api.py` | `5e15a6b806c8970040af51df82b9fb950a6cd28b0b3004c9a7c93916abfa3821` |
| `lct_python_backend/tests/unit/test_attendee_retained_source.py` | `a1f206d98d83950abec0385167b94f1326ad5b7a07e633223e74b00e67eeab76` |
| `lct_python_backend/tests/unit/test_transcript_review.py` | `343a7baa7a26c6ff5993c99f706dbf639a600e5e8bb40a9a88cb201749ea552e` |
| `lct_python_backend/tests/intent/attendee-retained-source.md` | `9056ae1c4958026efc1bc2b3553204e736fa879e8f7eb30bb453695368e55300` |
| `lct_python_backend/tests/intent/transcript-review.md` | `d873d1763e705bcb90e9e02ca0693293591918ece840d01db96a76582e1ac4d6` |
| `lct_app/src/services/transcriptReviewApi.test.js` | `f51289e6b98785c33c8e9d5b43dbd29d6a5955a1a3136fad5dd57b25c9830c0a` |

## Consolidation review and integration fixes

The manifest and twelve-test count above describe the original handoff, not the later integration bytes. Integration base is main `6b2a915069da2fbb03114a554f040fbcaf3fa639`.

Anthropic Claude Opus 5.5 (`claude-opus-5-5`) independently reviewed the exact 24-file range ending at `9acff77199c2a1419148dbb0fbc0e450e5ad25f8`, including the null-alignment guard, with four small unchanged auth/owner/transaction/transport excerpts. The 104,776-byte packet SHA256 was `3797b45b89709f486e17295d1aeefb233981dab05f7a62a2fb398948875ba615`. Common secret-pattern scan returned zero matches; only source, synthetic tests and technical documentation were included. Credentials, runtime values, databases, actual transcripts, participant data, media, screenshots and private/untracked notes were excluded. Existing authenticated subscription; tool-free runtime receipt confirmed tools=[], mcp_servers=[], one turn. Static review only.

Verdict was PASS with one low-severity finding: Retry audio lost the listening position. A public regression reproduced position4.2 resetting to0; retry now records the current position before reloading and preserves an already-pending word seek. Both recovery cases pass. A second independent pass will cover this updated source.

Reviewer questions checked against the actual contract: apiClient excludes AbortError from its network-failure counter; the earlier excerpt omitted that branch. Private source/transcript access deliberately requires an existing bearer token (AUTH_TOKEN preferred, ADMIN_AUTH_TOKEN fallback). The graph-refresh flag remains until a separately authorized processing path clears it. Transcript drafts survive switching; preservation of separate graph detail drafts is outside this slice. No disputed overclaim remains.

### Final source verdict

Anthropic Claude Opus 5.5 re-reviewed exact range `6b2a915069da2fbb03114a554f040fbcaf3fa639..d619119814e01f0a0168dee646bd05c99f7a7d69`: **PASS, zero actionable findings**. Packet112,982bytes, SHA256 `fde2db0a848fa28c31f5230b3f3bd72a18c3ac99c9f818200bc9d09e25833ccc`; same24files and four bounded unchanged context excerpts (the API excerpt now includes its abort catch). Secret-pattern scan remained clear. Runtime receipt again confirms tools=[], mcp_servers=[], one turn, with the existing authenticated Anthropic subscription.

The reviewer accepted the retry fix and null-alignment guard. Coordinator validation is83/83 backend,408/408 frontend in66files,15/15 focused frontend, scoped lint and production build. The reviewer ran no tests. Evidence precision: the position-restoration test failed before the fix; the pending-seek test already passed and guards against replacing an existing seek. A sentence in the review described both as previously failing; the baseline run was 1 failed / 1 passed (position test failed, pending-seek test passed), and no product decision depends on the reviewer's sentence.

Remaining limits are explicit: no live PostgreSQL or deployed UI verification; retry is a user-initiated resume action; cross-product correction sync and graph regeneration remain separate. Static inspection confirms transcript routes are included before existing conversation routes and do not share their paths. Metadata concurrency with other writers and very large existing utterances remain future validation considerations, not reproduced defects in this review. Copy-only recovery wording is tracked in ISSUES.md.
