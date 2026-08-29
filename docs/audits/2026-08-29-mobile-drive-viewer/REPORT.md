# Mobile Drive Viewer Gate — 2026-08-29

## Verdict

**Conditional pass.** The deterministic recipient journey passes on a 375 ×
812 coarse-pointer viewport, and the existing tablet/desktop browser contracts
remain green. Real Google OAuth return on a physical phone is still a
post-deploy check because the Codex browser controller failed to launch twice
on this Windows host; repo-owned Playwright remained healthy.

## Reader and task

- Reader: a time-pressured meeting participant opening a shared Threads link
  with moderate technical comfort.
- Primary job: open the map, understand one visible card, inspect its exact
  source utterance, return to the graph, and reopen the artifact later.
- Constraints: touch only, no hover dependency, 48px physical targets, no
  horizontal overflow, and no repeated Drive fetch after browser-local save.

## Interaction manifest

The synthetic, non-private Playwright journey exercised the actual UI:

1. Open `/browse` and import a valid `.threads` artifact.
2. Associate the saved browser-local record with an opaque Drive file id.
3. Open `/view?driveFile=...` and confirm no Google request is made.
4. Tap **Source**, scroll the exact utterance into view, and close the sheet.
5. Tap a visible connected card to enter one-hop relationship focus.
6. Tap **Show all**, then **Center**, and confirm the first card remains below
   the tier controls.
7. Open **Library**, reopen the saved artifact, reload, and confirm the cache
   still avoids Google.

## Findings repaired

### H-1 — Graph actions were smaller than the touch contract

The Source action measured 43.7px high after ReactFlow scaling. Coarse-pointer
graph actions now reserve 64 CSS pixels so their stable physical size remains
at least 48px while the map settles. Desktop pointer density is unchanged.

### H-2 — The first graph card opened under mobile controls

The first card began around 30px underneath the tier HUD. Compact framing now
uses one documented top inset for initial opening, refocus, and **Center**;
relationship focus adds the extra status-row allowance.

## Evidence

- [Map before source drill-down](evidence/mobile-map-before.png)
- [Map settled below the tier HUD](evidence/mobile-map-settled.png)
- [Exact source utterance sheet](evidence/mobile-source-sheet.png)

## Gates

| Gate | Result |
| --- | --- |
| 375px touch recipient journey | Pass |
| Tablet/desktop responsive journeys | Pass |
| Unexpected browser console errors/warnings | 0 |
| Network 5xx responses | 0 |
| Horizontal overflow / layout collapse | 0 |
| Stable exercised touch targets | ≥48px |
| Frontend unit suite | 309/309 pass |
| Browser suite | 16/16 pass |
| Production build | Pass |
| Scoped changed-source ESLint | Pass |
| Repository-wide ESLint | Known red baseline: 109 unrelated errors |
| Impeccable detector | Re-reported the tracked bookmark-corner overclaim |
| axe / physical-device OAuth / field performance | Not completed; post-deploy gate |

The local worktree's known Fontsource allow-list warnings and backendless
history diagnostic were classified explicitly; neither produced a production
build failure or a network 5xx.
