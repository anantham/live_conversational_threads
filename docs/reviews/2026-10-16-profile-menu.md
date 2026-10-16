# Profile menu and centered Start — 16 October 2026

Root integrates in `/Users/aditya/.codex/worktrees/lct-inference-choice/live_conversational_threads`, branch `codex/lct-inference-choice`, base `ef4fcd5e216eee39a9f3021fb08b199aa3aa4280`. User explicitly requested Profile inside More, routine local saving information in Settings, and centered Start.

## Behavior and acceptance

- More → Profile opens the existing account panel without navigation or disturbing capture. Its close button returns focus to More. Explicit hash links work; entering /new collapses the panel, leaving restores the previous undismissed default. Dismissal survives routes even when localStorage is unavailable.
- Routine saving status/link lives in Settings. Save failures and retry remain visible on the canvas.
- Idle Start is geometrically centered, with service indicators left. Active/paused controls are unchanged.
- Final combined suite: 1024/1024 tests in119files,9.64s, start23:02:57IST, `NODE_OPTIONS=--no-experimental-webstorage npm --prefix lct_app test`. Frontend/Worker build passes. Final source export330files.
- Actual synthetic browser verifies Profile open/close/focus, Settings status/link and no duplicate canvas status. At1280CSSpx Start center640; at320CSSpx center160, no horizontal overflow and indicators do not overlap. This preview refuses writes and uses synthetic identity/capabilities; no microphone, provider or real account operation was exercised through it.

## Independent review

Claude opus5.5, existing authorized account, final verdict PASS/zero findings. Packet69680bytes/SHA256 `6b9c758649a93adc3373a12fc9b264b236683993cc13a2ba16f88e0e61c49847`. Clean source/tests/intent only; tools disabled, no session persistence. Supported route-entry collapse, focus restoration and blocked-storage dismissal findings were fixed and included in final review. Preexisting overlapping panels/Escape/outside dismissal deferred. Static reviewer did not verify narrow service-indicator layout; root checked the actual320px browser. Raw reviewer reasoning remains temporary and is not published.

## Exact source hashes

- `lct_app/src/components/recording/ConversationNavigation.jsx`: `bb17c5094e9177c560844e913b889db7cf82b039e17a83f29a99d44f2b169792`
- `lct_app/src/components/SitesAccessPanel.jsx`: `6454a91577d8049d8428d86b057ce3c753f675d0c7770e3159c39c6c782ecf0e`
- `lct_app/src/pages/SitesNewConversation.jsx`: `a26ac55553cf1a187c00672d18994549688639590545cfb4af9cdec0a5824381`
- `lct_app/src/components/SitesAccessPanel.test.jsx`: `07bc88f6819673edb1f575c9de34eae280e66301f1ac3c593ca30e4a94b1fa4a`
- `lct_app/src/pages/SitesNewConversation.test.jsx`: `24f67c9026b01dd9929919272e23ac0428945c6093b423772da2f96344309cce`
- `tests/intent/sites-conversation-controls.md`: `f6d65238cf34305402596743e29f9d3d626dc27d4801a2718ad31be26f88cbee`

## Publication

Validated locally; existing public Site44/env37 is the rollback. Exact-source publication and live-browser receipt follow. No provider/account/domain settings are changed by this UI release.
