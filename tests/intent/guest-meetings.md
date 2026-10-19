# Guest meeting journey — test intent (19 October 2026)

- Through public Worker APIs, two independently issued browser capabilities isolate list/snapshot/audio/leave; malformed, duplicate, expired and cross-origin capabilities cannot send a bot or disclose content. Existing account/cloud APIs remain account-only.
- A Meet join requires explicit participant-permission confirmation, a supported URL, current readiness and fixed duration/capacity limits. Lost/duplicate responses reconcile the original ID, never automatically creating another bot.
- Realistic captions, map provenance and audio progress reach the browser; local IndexedDB saving is the default, reload/reopen preserves content, and ephemeral mode performs no conversation persistence or automatic cloud publication.
- UI handles admission, refusal, disconnect/reconnect, cancel/leave and storage failures truthfully; cloud history requires deliberate signed-in saving and public contribution remains explicit.
- Actual hosted guest browser → Asus bot → empty Google Meet → synthetic speech → incremental captions/threads/audio → local playable recording/reopen is required; mocks, empty fixtures, a successful build or server-only checks cannot substitute for this acceptance.

Live-audio acceptance uses Attendee's existing per-participant PCM chunk persistence without a transcription-provider call; an exact-source overlay shortens only explicitly enabled caption/audio-chunk buffers to five seconds. Scoped WAV reads, stable IDs, bounded download, no duplicate writes, optional playback and final-MP3 coexistence are required. Continuous mixed playback is only asserted after actual sound/playback evidence; counters or mocked bytes alone do not prove it.
