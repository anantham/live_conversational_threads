# Supervision (optional)

LCT's backend can run as a peer agent under IndrasNet's `start_all.py`
supervisor instead of being launched manually via `start.command`. When
enabled, LCT inherits the same auto-restart, wedge detection, and
persistent-failure alerting that IndrasNet's own `web_server` enjoys.

This is **opt-in** and **co-located with IndrasNet**. On machines where
IndrasNet is not running, set up your own supervision (systemd, NSSM,
launchd, plain `start.command`) — this doc only covers the IndrasNet
co-location case, which is currently the only deployment topology.

## Activate

On the machine running IndrasNet's supervisor (currently the GPU box):

```
setx ENABLE_LCT_BACKEND 1
```

Then either reboot, log out and back in (the `IndraSupervisor` scheduled
task fires on logon), or manually restart that task from Task Scheduler.

On next launch, `start_all.py` will spawn:

```
<lct_repo>/.venv/Scripts/python.exe -m uvicorn \
    lct_python_backend.backend:lct_app --host 0.0.0.0 --port 43181
```

with `cwd=<lct_repo>` so LCT's package + `.env` resolve correctly.

## What you get for free

- **Port-readiness gate** — supervisor waits for port 43181 to accept
  TCP connections before declaring "started." If LCT fails to bind in
  60 seconds the entry is logged as failed.
- **Auto-restart** with exponential backoff (max 5 attempts, max 60s
  delay, crash counter resets after 5 minutes of stability).
- **Wedge detector** — watches `<lct_repo>/logs/backend.log` mtime. If
  process is alive but the log has been silent >300s (past a 180s
  grace), force-restart. Catches asyncio event-loop deadlocks that
  don't crash the process.
- **Persistent-failure escalation** — after max retries, structured
  telemetry row + Beeper Saved Messages alert (if Beeper credentials
  are set on the supervisor side).

## What you DON'T get

- **Code reload on edit** — supervisor restarts on crash, not on file
  change. Edit + save → run-on-the-supervisor doesn't pick it up.
  Use `start.command` for the dev loop; the supervisor is for "I want
  this running 24/7 without thinking about it."
- **Dependency-on-IndrasNet enforcement** — LCT and IndrasNet's
  web_server start in parallel. LCT must degrade gracefully when
  IndrasNet is briefly absent (currently: `/api/contacts` returns
  empty list, picker shows "No contacts available"). This is
  intentional; no explicit dependency edge is enforced.
- **Cross-repo env merging** — the supervisor process has IndrasNet's
  `.env` loaded into its environment. LCT's `backend.py` calls
  `load_dotenv(..., override=True)` so LCT's `.env` wins on conflict
  (`DATABASE_URL`, `AUTH_TOKEN`). If you ever launch LCT some other
  way that doesn't go through `backend.py`, repeat the override or
  you may quietly point at the wrong DB.

## Port conflict behavior

If port 43181 is already listening when the supervisor tries to start
LCT (e.g., you already ran `start.command` in another window), the
supervisor logs:

```
[SKIP] lct_backend: Port 43181 already in use (existing server?)
```

…and treats it as a successful "service available." This prevents
double-start. To force the supervisor to own the process, stop the
manual instance first.

## Disable

```
setx ENABLE_LCT_BACKEND ""
```

Then restart the supervisor task. The entry will be silently skipped
on next start because the env_check fails.

## Cross-repo file map

| File | Repo | What it does |
|---|---|---|
| `scripts/start_all.py` AGENTS dict | IndrasNet (`grimoire/IndrasNet/`) | Registers `lct_backend` with `python_executable` + `cwd` overrides |
| `lct_python_backend/backend.py` `load_dotenv(..., override=True)` | LCT | Wins env conflicts with supervisor's parent env |
| `<lct>/logs/backend.log` | LCT | Wedge detector's freshness signal; LCT's structured logs |
| `grimoire/IndrasNet/logs/lct_backend.launcher.log` | IndrasNet | Captured stdout+stderr from each launch |

## References

- IndrasNet **ADR-040** §"Cross-repo peer agents" — the schema extension,
  invariants, and rationale for separating the two repos.
- IndrasNet **`docs/indrasnet/LOGGING.md`** §"Cross-repo peer agents" —
  log-stream layout and how to diagnose by triangulating across
  launcher/peer/supervisor logs.
- Supervisor commits: IndrasNet `24e0a3c` + LCT `9cced35`.
