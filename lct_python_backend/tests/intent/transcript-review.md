# Transcript review intent
- Graph and Transcript share the same conversation and persistent audio; switching preserves position and drafts.
- Only real matching word timing permits word seek; segment fallback and missing/caption-relative audio remain explicit. Corrections never manufacture alignment. Malformed stored alignment remains readable and falls back to segment seeking.
- Owner-authenticated text corrections atomically compare expected text, update existing Utterance and EditsLog, preserve original TranscriptEvent and audio identity, and reject stale/nonowner/deleted targets.
- Saves and reads show stage/elapsed/unknown remaining time; failure keeps drafts, cancellation/navigation cleans up, keyboard and narrow-screen review remain usable.
- LCT corrections do not synchronize Meet Review without an explicit cross-product revision contract.
