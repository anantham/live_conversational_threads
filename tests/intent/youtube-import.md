# Test intent: YouTube transcript import (2026-11-25)

Covers `lct_app/src/services/youtubeImport.js`, `lct_app/sites/youtubeImport.js`,
`useYouTubeImport.js` and `SitesYouTubeImport.jsx`.

- A pasted link is classified without being trusted: only youtube.com / youtu.be, valid ids, no
  credentials or ports, and refusals carry a fixed plain message. Auto-generated mixes, Liked videos and
  Watch later are refused; a watch link that carries a mix still imports its video.
- Caption XML becomes timed tokens the existing transcript builder accepts, losing no words or time even
  when a video has more cues than the builder allows. Empty or oversized captions fail loudly.
- The Worker talks only to youtube.com, validates every id and caption address before use, caps every
  upstream body, follows no redirect, forwards no visitor header, and never returns upstream text.
- The page imports one video per conversation, keeps playlist order, saves locally, and sends nothing to
  an AI provider until the user opens AI map and consents.
- Stubbed YouTube only in automated tests. One live run against the owner's playlist is recorded in
  docs/WORKLOG.md; it cannot be automated because it depends on YouTube's current behaviour.
