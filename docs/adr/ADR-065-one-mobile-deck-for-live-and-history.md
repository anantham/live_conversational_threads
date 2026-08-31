# ADR-065: One Mobile Conversation Deck for Live and Historical Reading

**Status:** Approved  
**Date:** 2026-08-31  
**Decider:** Aditya  
**Group:** Presentation  
**Related:** ADR-011, ADR-016, ADR-021 (authored hierarchy), ADR-031

## Issue

A dormant live-tangent prototype introduced a second three-card interaction
surface. The shipped mobile conversation deck already owns the product's two
navigation axes: temporal movement among siblings and vertical movement through
authored abstraction to exact utterances. Reviving the old surface would create
two grammars for the same conversation.

## Decision

Extend the existing mobile deck with live-time state instead of adding another
viewer. A null live cursor means “following live.” Moving backward pins the
reader to that historical position. While pinned, newly arriving nodes do not
move the current card. The deck shows how far the reader is behind and offers a
direct return to live. Returning live preserves the authored abstraction trail
where it still resolves.

Historical artifacts retain their current behavior and never show live chrome.
Live nodes must enter the same authored hierarchy contract as historical nodes;
the UI does not infer a competing graph from websocket arrival order.

## Positions Considered

1. **Extend the existing deck (chosen).** One learned interaction grammar and
   one source of hierarchy truth.
2. Keep a feature-flagged live-only tangent surface. Rejected because it
   duplicates gestures, cards, and accessibility behavior.
3. Preserve design notes only. Rejected because live-follow versus pinned
   history is still useful and distinct.

## Consequences

- Left/right remains chronological within the selected parent; up/down remains
  abstraction depth.
- A live reader can inspect history without being yanked forward by new data.
- The live/history controller is extracted from the already-large deck rather
  than adding another mixed concern to it.
- Controls remain touch-sized, keyboard-reachable, and truthful at boundaries.

## Verification

Pure model tests must cover initial live-follow, explicit pinning, stable
history when new nodes arrive, distance-behind-live, return-to-live, and
preservation of the abstraction trail. Component tests must prove live chrome
is absent for historical artifacts and present only when meaningful.

