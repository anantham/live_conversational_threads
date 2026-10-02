# Viewer Legend space

Date: 2026-10-03. User approved reducing the bottom gap and keeping the Legend
clear of Source and node details. Preserve content, naming, navigation and focus mode.

- A populated public viewer places its collapsed Legend 12px above the timeline,
  with both the timeline collapsed and expanded, at desktop/tablet/phone widths.
- Legend and moment controls share allocated space outside Source/details;
  normal pointer and keyboard interaction reaches every control without overlap.
- The open key remains bounded and scrollable for long labels, short viewports,
  and combined Source/details/timeline states; it causes no document overflow.
- Moment stepping, history, immediate aliases, close/reopen and focus-mode
  behavior survive the layout change. SDK mocks prove layout only, not playback.
- Other graph consumers retain their existing floating controls and Legend.
- Fixture readiness requires authored memberships and all14 visible thread counts;
  empty graph/timeline output cannot satisfy pane or navigation acceptance.
- Compact text Source follows the existing video parent-height cap; all controls
  remain scrollable when combined panels leave little vertical space.
