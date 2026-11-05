# Settings and account controls — 16 October 2026

Root integrates in `/Users/aditya/.codex/worktrees/lct-inference-choice/live_conversational_threads`, branch `codex/lct-inference-choice`, base `cb322d28b67ef03865c6dd424c3a41d5b58c7605`. User explicitly requested moving Live transcription to Settings and replacing Sign out with an icon while removing visible Signed in. Storage status placement was only questioned and is unchanged.

## Behavior and evidence

- Same transcription selection, provider refusal, consent and recording controls; Settings locks during pending consent, active capture and pause. Unavailable selected transcription has an idle Settings recovery link, omitted when controls are locked.
- Icon-only Sign out keeps its accessible name, tooltip, request ordering, retry and cancellation behavior. Signed-in copy describes saving; the redundant visual status is screen-reader-only.
- Final combined suite: 1022/1022 in119files, 7.73s, started22:16:32IST. Command: `NODE_OPTIONS=--no-experimental-webstorage npm --prefix lct_app test`. An earlier invocation omitted the established Node26/jsdom compatibility flag and failed in browser-storage fixture setup; no assertions were weakened. Final frontend/Worker build passes.
- Actual browser preview verifies Settings toggle/caption relocation, toggle interaction, footer Start, signed-in copy and icon. Preview uses explicitly synthetic account/capability responses and refuses writes. No microphone capture, provider request, real sign-out or private-data action was performed. Screenshot `/private/tmp/lct-signout-icon-preview.png` is synthetic layout evidence.

## Independent review

Existing Claude account, different family from Codex implementation; model claude-opus-5-5. Source-only clean packet, no tools/memory/session persistence. Final verdict PASS, zero findings. Packet SHA256 `2ea18e6ad7b08437ae43dfc3f124846f77102eeb6eb067fe51b8f4a2dfcd9d97`,66015bytes. Raw output remains temporary; this receipt records findings rather than private reviewer reasoning.

Supported findings fixed: unavailable selected-mode recovery discoverability; screen-reader sign-in announcement; paused-state hint offered a locked control. Existing tests gained consent/paused assertions and unavailable-capability refresh while paused. Optional footer caption declined because user moved that entire block into Settings; consent and Start accessible description retain mode information. Claim of missing unavailable recovery coverage was disproved by the existing test. Static review did not run tests or assistive technology; root ran tests/browser checks above.

## Exact reviewed source hashes

- `lct_app/src/components/recording/CloudRecordingToolbar.jsx`: `d2cdb3c20de435f626b8f772eb4e9839b943f5871b29db5510009f5247dfc502`
- `lct_app/src/components/recording/ConversationTranscriptionSetting.jsx`: `308739cd5c72c5510717002c9ed7331225c7f3595fc491d883e6ba4f23830d06`
- `lct_app/src/pages/SitesNewConversation.jsx`: `ea5db94a747d58c4d693695519527656a607a18c9615849375ec92c37bd519c5`
- `lct_app/src/components/SitesAccessPanel.jsx`: `9d7df254f88471acf9dbaff4c895f47ab896dff0e878fdb09892258075c5177c`
- `lct_app/src/pages/SitesNewConversation.test.jsx`: `31526709f2959e9b9fbe9b345ed3188b45e6f1f810f9af415f1aaca9b4684f20`
- `lct_app/src/components/SitesAccessPanel.test.jsx`: `cf4543924e1fc5b01c74bfa5cb8709181277234e836f80f29b2d04be433556ee`
- `tests/intent/sites-conversation-controls.md`: `f00907879d3d8726931e6f294ff60c13e533a3f541905ab44f8b48b45b55ed5c`

## Publication

Application source `b037417` is committed and pushed. Native source `4875c4129aff3b914bbdcb491f329b40b12130f3` is pushed and served as public Site44, environment37; deployment `appgdep_6ad2558596688191bb43410ff0aa864c` succeeded2026-10-16T16:49:42.497780UTC. Saved version `appgprj_6abe98e1b1b08191b2b763a78e1da819~appgver_d7060ffcd60c8191b218f93709e74366`. Archive SHA256 `bf1c5d94bb7c94a72b5760368b4fa1a7f3256da5199939d48a69201fed4f73ca`,39files/1925120bytes.

Fresh separate live browser tab confirms `/assets/index-BmU8Nxpl.js`, Settings contains the live-transcription toggle/caption and footer contains only Start. Live screenshot `/private/tmp/lct-settings-controls-live.png`. That browser is a guest, so signed-in appearance was verified with the synthetic preview, not claimed as a live-account test. Existing user conversation tab was untouched. Public URL: https://threads-adityaarpitha-cloud.avalokai.chatgpt.site . Previous Site43/env37 is the rollback. No audience, provider, application credential, storage or domain configuration changed.
