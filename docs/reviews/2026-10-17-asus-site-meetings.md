# Asus-to-Site meeting integration review — 17 October 2026

Author/integration: OpenAI Codex/root. Reviewer: Google Gemini 4 Argon Medium through the existing authenticated AGY subscription. Source-only saved packets in a clean review directory; fresh conversations, plan mode, slash expansion disabled and explicit no-tool/no-edit instructions. No credentials, real meeting URLs, participant data, recordings, transcripts, private runtime logs or unrelated files were disclosed. Practical client isolation is not proof of enforced tool denial; each result reports one turn.

The first 141,814-byte packet (`55c32abbac022714fd235d2d0d016dd0ec90db7e7e84d8a77d157bc944a6afd1`) returned findings in conversation `6d472f43-b077-4dea-a657-b3d0de8ba789`. Supported fixes cover DRF audio negotiation, platform-caption provenance and stable participant IDs, preserving unreadable stored maps, paused-state naming, leave/auto-leave races, and offline archive restoration/unchanged-poll writes. A suggestion to overwrite a stored unreadable map was rejected; its existing bytes remain untouched.

The revised full 152,400-byte packet (`daa6417c3c0b35502b91128f2000cf897c472bc6b57d4c51948d574e2c6e5ab8`) returned **PASS** in fresh conversation `f4c6b320-ccf6-4f85-a5d7-59ed6e7975f7`,42.72seconds. One nonblocking display observation was confirmed and repaired: show participant names while retaining stable IDs in source artifacts. The final 17,140-byte display/test packet (`5c0a14b8c6f7831bd881d45d1fb41b290ccf34982cdfa93aaf9aa3c75b051bc4`) returned **PASS** in `4f63d989-0e8c-4d9d-a917-db0a36d833cb`,13.15seconds. Its optional defensive label inheritance is unnecessary for the current mapper, which supplies a label on every utterance token.

Validation:1048 combined checks across122 files passed again after the final one-line display repair, including the name-vs-ID assertion.4 isolated Python preparation/range checks passed. Final client/Worker build and actual isolated Chromium1280/375px checks pass: one intercepted join, one intercepted generation, one transcript copy, no horizontal overflow. These are synthetic API/UI checks, not proof of Meet admission, actual captions, playable recording or paid model generation.

Runtime remains a separate gate: exact upstream500168b image build, new-volume API/storage/sandbox checks, authenticated existing-Site relay, then the board's seven finite real acceptance checks. This review does not authorize broader hosting, public recording access, quota resets or new spending. No existing Site release has changed at this receipt.

## Final reviewed source hashes

- `attendee_stack/recovery/prepare.py`: `1c7ec3b3ace46c45d9ce54afda17ed3acf9b6e6067d5db5daa7c6c3fed16ca87`
- `attendee_stack/recovery/settings.py`: `9739643d3225ea0b73db38182559c5090151dbf79ce5a5cde7594fdf11029ff9`
- `attendee_stack/recovery/cloud_api.py`: `3c2f2ef53f981f609c794a5720524b1d22cc452e3b9f952eda2c3df380593bf6`
- `attendee_stack/recovery/audio_range.py`: `2c80623a4d8c346ffcc6e2bf5a857259a83a0493e7e1be86e3e2c8db1938a4bf`
- `attendee_stack/recovery/test_audio_range.py`: `aa494322a66f403c50d0dafb69abab2119e1c8e871e4858c16aec5eb688d254c`
- `lct_app/sites/meetingPolicy.js`: `56b585845438892be11f8933501bea0aacda29701419320bc846df59b7a2ce7a`
- `lct_app/sites/meetings.js`: `4c5902e4b9acc3e3563be3baa584c7d9dc1fad2616963019f31c9cb67d4bccb8`
- `lct_app/drizzle/0013_meeting_owner_receipts.sql`: `de1faefe76e9849e3be8513c14de427f7be1b947490cdd64f7634f6084a46493`
- `lct_app/src/hooks/useMeetingArchive.js`: `57e434bc5a99f6aa0fd41e7dc87405329aad5c293d3397af954c2a3ad35e58c6`
- `lct_app/src/hooks/useSiteMeeting.js`: `a3550b42317ebf09991bc1a269fba9e7e85a56689994b7af65a8128ae6dc15e1`
- `lct_app/src/hooks/useConversationArchive.js`: `ab4a0ad122860a57b96f5d8bdf8dbeb677220402c4cc690e23b339dd40312189`
- `lct_app/src/services/cloud/conversationArchive.js`: `2b2cff5cff4834d1d194bb82d9523b8e1ea0ae74ac8c003c1141dbb6f0379e0e`
- `lct_app/src/services/cloud/sitesMeetings.js`: `64ea06d947dd4e2632ad4cda6c165456d5b59f4335ba2ec01c5462ad93aa8aa3`
- `lct_app/src/pages/SitesMeetingView.jsx`: `89a5eed793682128c8d5150ce93d0a088626f7f4ade499009baa68b4def540b2`
- `lct_app/src/pages/SitesMeetings.jsx`: `519d273752ff664b475ead70c45326517b9d7c964b51782e47163c9ab090cae9`
- `lct_app/src/pages/SitesMeetings.test.jsx`: `18099678f4734ff3e723809c89ec331a216efa15e71b8424a53a0b992ab6f48c`
- `lct_app/src/services/cloud/sitesMeetings.test.js`: `eb4968887d13f043b9cc56db7343b9e1662056733980964dc4ed4ee755a7eae6`
- `lct_app/src/services/serverless/sitesMeetings.test.js`: `637da0c65f1aa7e06271dbb93c96429741955e46a87e836af94c5453165c8e25`
- `lct_app/src/components/recording/ConversationTranscriptPanel.jsx`: `325edfdd54b20579452967913a8748c807738d16603f5723a163e1fe3a8e6d77`


## Sanitized export and native preparation

The export allowlist initially omitted the two new Worker modules. A native Node regression reproduces ERR_MODULE_NOT_FOUND against the isolated exported worker before repair and succeeds afterward. Final combined1049/1049 checks across122files and a fresh339-file standalone source build pass. Independent Gemini review PASS,28.64seconds, fresh conversation92208b39-27fd-435e-8869-744fe41d2c31; packet20754bytes/SHA2560963aee3c68e95b47d7e7199a5c838e2d65d692c0d2a374eb171bbce94b1292d. This also reviewed the exact schema, migration journal, routing, account-panel and navigation wiring.

Official Sites helper rebuilt, committed and pushed native source `acbbeb987fbe806d8d051198c1119c80f3cd2667`. Prepared archive `/private/tmp/lct-meet-site-e52e060.tar`,632438bytes,SHA2565747f0b60a18ff259b8aea1eb38aa2dfee2400992e3fc1bbbc47331e828a146a. Automatic publication was false; no save-version/deploy call followed. Existing public release45/env37 remains the runtime baseline. The prepared source and archive are not live-user acceptance.
