# Import a transcript from a pasted YouTube link

- **Date:** 2026-11-25
- **Status:** Proposed
- **Group:** integration

## Issue

The owner wants to paste a YouTube video or playlist link and get its transcript into the Site. The Site
had YouTube playback (`youtubeMedia.js`) and audio file import, but no way to turn a link into text
(`docs/plans/2026-10-01-lct-sites-migration.md` records that question as unanswered).

## Decision

1. A Worker route pair, `GET /api/cloud/youtube/resolve?url=` and `GET /api/cloud/youtube/transcript?v=`,
   reads public YouTube data: a video title (oEmbed), a playlist's videos (innertube `browse`, up to four
   pages / 300 videos) and one video's existing captions (innertube `player`, then the caption track).
   It stores nothing and spends nothing.
2. Captions only. A human-written English track is preferred, then automatic English, then any written
   track. Videos without captions, private and age-restricted videos, and live streams are refused with a
   plain message. Audio is never downloaded.
3. One video becomes one conversation. A playlist is a list to choose from, not a batch, because the app's
   working view is one conversation and each map costs a counted provider request.
4. The transcript is saved locally like any import. Nothing goes to an AI provider until the user opens
   AI map and gives the existing consent. Videos over about 20 minutes show a warning, because map
   generation is measured only to that length (`docs/reviews/2026-11-03-long-input-envelope.md`).
5. Access follows the generation audience: public when `LCT_OPENROUTER_AUDIENCE=public`, otherwise
   sign-in. A custom request header proves the call comes from the Site.

## Positions considered

- **Fetch from the browser:** impossible, YouTube sends no CORS headers.
- **A separate service on the M5/Asus:** avoids datacenter blocking but adds a public, maintained service.
  Kept as the fallback if Cloudflare is refused (below).
- **Download audio and transcribe:** works for caption-less videos but needs yt-dlp-style tooling, is
  heavy, and raises terms-of-service questions. Not done; the existing audio import covers a downloaded file.

## Risks and assumptions

- **Cloudflare egress is unverified.** Automated runs from this Mac's residential address succeed for all
  five videos of the owner's playlist. YouTube often refuses datacenter addresses (`LOGIN_REQUIRED`). The
  Worker reports that as `youtube_blocked` with an honest message. Whether the hosted Site is affected can
  only be known after publication. If it is, the fallback is the separate service above.
- Innertube is undocumented and changes. The playlist reader accepts both the current and legacy shapes;
  a change would surface as "playlist unavailable", not as wrong data.
- Automatic captions have no speakers and no punctuation; the map and viewer treat them as one speaker.

## Consequences

New public-facing route group on the Worker; no migration, no new setting. Reversible by removing the
handler. Imported conversations carry `recording.youtube` (video id, title, length, caption kind).
