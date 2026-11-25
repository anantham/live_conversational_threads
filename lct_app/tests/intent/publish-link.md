# Publish & copy link (2026-11-25)

- From the import page, a finished map is published in one step as an **unlisted** link: it opens for anyone
  with the link and is never shown in the public library list (owner choice). Older clients without the
  visibility header still publish listed copies.
- By default the published copy leaves out attendee emails, Drive/Doc/calendar links, Gemini's notes and media
  links; an explicit box includes them. The map, transcript and speakers' words are published, under an
  explicit consent naming that.
- The removal key is saved on the device before anything is sent, and offered for download afterwards.
- Size limit 1.5 MiB (owner chose raising the limit over trimming files); it stays under Cloudflare D1's
  2,000,000-byte value limit, and migration 0020 widens the database CHECK to match.
