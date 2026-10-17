# Asus-backed private meeting pilot

- Exercise public Worker APIs with the real additive SQLite schema and synthetic recorder responses; no live meeting or provider is contacted.
- Prove absent configuration/schema, guest/other-owner, CSRF, malformed URL and expired window refuse before sending a bot.
- A duplicate request cannot create another bot, including after the original ends; ambiguous creation retains its ID/reservation and GET reconciles without POST.
- One active/unconfirmed meeting at a time; snapshots, audio and leave require matching owner; redirects and malformed upstream responses never expose credentials.
- Actual captions, audio playback, browser reconnect and Mac-disconnect acceptance remain required on the recovered runtime, in a newly authorized empty room.

- UI: explicit join consent, closed window, uncertain create reference, full-snapshot deduplication/reconnect, source-linked map generation with provider consent, private audio access/local copy, ephemeral no local persistence and viewer unmount without leave.
- Use existing local archive queue; audio is copied only after finalized recording, bounded to20MiB, and copy failures never hide the private remote recording.
