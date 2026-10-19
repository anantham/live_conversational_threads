# Asus-backed private meeting pilot

- Exercise public Worker APIs with the real additive SQLite schema and synthetic recorder responses; no live meeting or provider is contacted.
- Prove absent configuration/schema, guest/other-owner, CSRF, malformed URL and expired window refuse before sending a bot.
- A duplicate request cannot create another bot, including after the original ends; ambiguous creation retains its ID/reservation and GET reconciles without POST.
- One active/unconfirmed meeting at a time; snapshots, audio and leave require matching owner; redirects and malformed upstream responses never expose credentials.
- Actual captions, audio playback, browser reconnect and Mac-disconnect acceptance remain required on the recovered runtime, in a newly authorized empty room.

- UI: explicit join consent, closed window, uncertain create reference, full-snapshot deduplication/reconnect, source-linked map generation with provider consent, private audio access/local copy, ephemeral no local persistence and viewer unmount without leave.
- Use existing local archive queue; audio is copied only after finalized recording, bounded to20MiB, and copy failures never hide the private remote recording.

- The sanitized source export must retain the meeting handler and its policy dependency so the exported Worker can load; test without source-directory fallback.

### Host UI identity guard (17 October 2026)

- Bind the join action to the exact approved Meet URL and selected host account.
- Refuse wrong room/account or enabled microphone/camera permission before any click.
- Exercise wrong-account refusal on the real prejoin, then observe the real allowed join and empty room during the bounded pilot.
- Written test exception: this operator-only CUA guard uses actual Google UI acceptance instead of a mocked browser that could manufacture permission/identity readiness. It must not report an attempted click as a joined room.

### Cloud test-session guard (18 October 2026)

- Before a sign-in handoff or pilot join, bind the operator tab to the selected live HTTPS Site origin; localhost and other origins refuse.
- Bind the actual visible /api/auth/session response to the approved qualified recording owner, independently of the Meet host account.
- Written test exception: exercise wrong-origin/wrong-owner refusal and allowed owner against real CUA tabs, with no browser mocks or network injection. The guard does not sign in, mutate data or join.

### Independent bot-duration cap (20 October 2026)

- A server-only90second cap bounds the recorder request and persisted receipt independently of a longer admission window; client input cannot increase it. Omitted cap preserves300seconds; a shorter remaining window wins.
- Invalid explicit duration caps refuse new joins before any reservation or recorder call.
- Existing owned snapshots and leave remain available when the new-join cap is invalid, preserving cancellation/history access.
