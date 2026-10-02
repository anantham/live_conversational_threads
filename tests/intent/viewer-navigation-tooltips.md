# Viewer navigation tooltip intent

- A populated viewer distinguishes exploration-history Back/Forward from chronological moment Previous/Next through visible hover and keyboard-focus help.
- Disabled controls still explain unavailable navigation; the native disabled buttons never activate, and disabled help can receive keyboard focus.
- Hints dismiss with Escape, remain readable when the pointer enters them, and disappear on blur/leave/navigation without leaking listeners or timers.
- Conversation/thread scope and first/last boundaries are accurate. Existing handlers, counts, arrow shortcuts and desktop/phone control geometry remain unchanged.
- Closing details keeps the selected thread's label when its reading path remains active. Selecting a moment outside that path switches the label and count to the full conversation.
- Tooltip bounds stay inside the visible viewport with Source/details/timeline combinations. Reduced-motion readers receive no imposed animation.
