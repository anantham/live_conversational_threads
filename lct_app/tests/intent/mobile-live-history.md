# Test intent: live history in the existing mobile conversation deck

- A live deck initially follows the newest node while a historical artifact
  preserves its existing initial position and shows no live-only chrome.
- Moving backward pins the current authored sibling; new arrivals do not move
  the reader and increase the truthful distance-behind-live count.
- Returning live selects the newest compatible sibling and preserves the
  current abstraction trail wherever the authored hierarchy still resolves.
- All time/depth boundary messages and keyboard, button, and swipe semantics
  remain unchanged outside the new live-follow state.
