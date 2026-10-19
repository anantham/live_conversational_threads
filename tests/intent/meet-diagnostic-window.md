# Diagnostic window intent

- Preflight time must not consume the short bot window. The same-user supervisor waits at most 120 seconds for an explicit pre-dispatch handshake, then acknowledges an 85-second deadline before the UI dispatch; no acknowledgement means no bot.
- Invalid worker/deadline, absent timer or repeated Begin refuses; optional recorder-side continuation requires the active timer and at least 30 seconds left. Existing data and prior one-shot guard files are retained.
- Execute the unchanged production handshake prefix in isolated synthetic files for valid, absent, wrong-worker, too-long and too-short triggers. The fixture deliberately ends before Docker actions. This is a security-sensitive protocol test; actual exact-worker stop was already observed separately, including its persisted receipt and Docker FinishedAt.
- Validate real four-terminal-bot/schema/deepcopy/wire preconditions without POST, and ensure the actual stopped worker cannot pass readiness. No real timer, restart, bot, caption/audio, or map in these checks.
- Successful stop is established by the exact persisted receipt and actual Docker state; a cached null Start-Process ExitCode must not manufacture failure. A real complete Meet test is a separate acceptance gate.
