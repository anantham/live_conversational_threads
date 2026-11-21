# ADR-073: Move the production backend and its database to the M5

- **Date:** 2026-11-05
- **Status:** Proposed
- **Group:** Deployment / operations
- **Related:** ADR-034 (owner tier stays self-hosted), ADR-056 and ADR-066 (M5 STT),
  ADR-069 (supervisor liveness). Does not supersede an ADR.

## Issue

The production backend (`:43181`) and its Postgres run on the Asus. When the Asus is
unreachable, the app is down. Observed on 2026-11-04 and 2026-11-05: the Asus dropped
off the tailnet about five times in two days, including about 02:03–03:50 on 11-04 and
several short drops on the morning of 11-05 after a reboot at 09:34. On 11-05 from
11:28 to 11:30, both supervised services on the Asus (`web_server` and `lct_backend`)
failed health probes at the same moments, which points to stalls of the whole machine,
not of the backend. That cause is a correlation and has not been confirmed. Windows
Defender and Beeper had used about 3,600 and 4,000 CPU-seconds in the two hours after
boot.

The M5 is on AC power with system sleep disabled on AC, already runs the STT services
the backend depends on (`:5095`, `:5096`), and already exposes tailnet-only HTTPS with
`tailscale serve`.

## Decision (proposed)

Run the production backend and its Postgres on the M5. The Asus keeps its other roles
(GPU, LM Studio, IndrasNet), which the backend reaches over the tailnet as it does today
for STT.

| Component | Asus today | M5 after the move |
|---|---|---|
| Postgres | PostgreSQL 15.15 (Windows service `postgresql-x64-15`) on `127.0.0.1:5432`, database `lct_dev` | Homebrew `postgresql@15` (15.18, already installed, not running) on `127.0.0.1:5432`. Same major version, so a plain dump and restore. Production has only the `plpgsql` and `uuid-ossp` extensions; the one migration that wants `pgvector` skips it when unavailable, so pgvector is not needed |
| Backend code | Asus checkout of `main` | M5 clone, branch `deploy/origin-main` (its local `main` is an unrelated history) |
| Python | 3.9.21 | The M5 clone's `.venv` is 3.12.13, closer to CI. Removes the "passes CI, breaks on 3.9" class |
| Supervisor | IndrasNet `start_all.py` via `\IndraSupervisor` | LaunchAgent `com.aditya.lct-backend` (`KeepAlive`) plus a `/api/import/health` check in the existing `com.aditya.stt-watchdog` pattern, because launchd restarts only on exit and cannot see a hung process |
| Address | `https://asus-strix-scar.tail4741ad.ts.net` | `https://adityas-macbook-pro.tail4741ad.ts.net:5449` (free; ports 5443–5448 are taken) via `tailscale serve`, tailnet-only like today |
| Logs | `logs/backend.log` | the same path in the M5 clone |

Data to move, measured 2026-11-05: the database is 237 MB (`speaker_segments` 155 MB,
`utterances` 19 MB, `transcript_events` 17 MB, `thread_session_events` 17 MB; Alembic
head `add_transcript_revisions`); recordings in `lct_python_backend/recordings` are
0.57 GB in 99 files, newest 2026-09-25 (`AUDIO_RECORDINGS_DIR` is unset, so the default
path); and the ADR-068 runtime data in `%LOCALAPPDATA%\LCT` is one file, which moves to
`~/Library/Application Support/LCT`. The whole copy is under 1 GB.

### What still depends on the Asus after the move

- LM Studio (`LOCAL_LLM_BASE_URL`, default `http://100.81.65.74:1234`, used by
  `services/llm_config.py`): local-LLM calls fail while the Asus is down. Ollama
  on the M5 (`:11434`) is a possible later replacement; it is not part of this move.
- IndrasNet (`INDRASNET_BASE_URL`, `services/indrasnet_client.py`): enrichment fails
  while the Asus is down. The `.env` value must change from `127.0.0.1:7777` to the
  Asus tailnet address, and IndrasNet must accept tailnet connections.
- The Attendee meeting bot (Docker on the Asus) posts webhooks to
  `http://host.docker.internal:43181/api/attendee/webhook`. After the move, its webhook
  URL must point at the M5 address, or meeting-bot transcripts stop arriving.

## Plan

**Preparation (M5 only, no downtime, reversible):**
1. Start the installed `postgresql@15` on `127.0.0.1:5432` with `brew services`;
   create the role and the `lct_dev` database.
2. In the M5 clone: update `deploy/origin-main` to `origin/main`, install the backend
   requirements into `.venv`, and run the unit suite there.
3. Write the M5 `.env` from the Asus key list (53 keys): new
   `DATABASE_URL`, `INDRASNET_BASE_URL` and STT hosts as above. Secrets are copied
   machine to machine, never through a repo or a review packet.
4. Rehearsal: restore a fresh Asus dump into the M5 database, run
   `alembic upgrade head` (expected: no-op), start the backend by hand on a spare port,
   and check `/api/version`, a conversation list and a small audio import. The Asus
   stays the production backend throughout.
5. Add the LaunchAgent and the health check; add `tailscale serve --https=5449`.

**Cutover (needs the Asus online; downtime about 15–30 minutes):**
6. Announce a window and confirm no import is running (`logs/backend.log`).
7. Stop the Asus backend and keep it stopped. The IndrasNet supervisor restarts it on
   any exit, so it must be told not to: `ENABLE_LCT_BACKEND=0` in IndrasNet's
   environment plus a supervisor restart, or an equivalent stop control. This touches
   the TemporalCoordination checkout on the Asus and needs that lane's agreement.
   (Its `RESTART_REQUESTED` file only restarts the backend; tested 2026-11-05.)
8. Final `pg_dump -Fc` on the Asus, copy it over the tailnet, `pg_restore` on the M5.
   Copy `lct_python_backend/recordings` and the `%LOCALAPPDATA%\LCT` file.
9. Start the M5 backend under launchd; verify `/api/version` (new pid, expected SHA,
   `git_dirty: false`) through the tailnet URL.
10. Owner: change Vercel `VITE_BACKEND_API_URL` to the M5 address and redeploy.
    Owner: change the Attendee webhook URL.
11. Smoke test from the live site: open a conversation, upload a short audio file, run
    a short live recording.

**After:**
12. Nightly `pg_dump` on the M5 to a second location (to be chosen), and a restore drill.
13. Update AGENTS.md "Backend" and the memory notes; the Asus restart runbook becomes
    the rollback runbook.

## Rollback

Until step 10, rollback is restarting the Asus backend (its database is untouched; the
dump is read-only). After step 10, rollback means pointing Vercel back at the Asus and
re-enabling `lct_backend` there, and anything written on the M5 after cutover must be
dumped back first or it is lost. Never let both backends take writes at the same time.

## Considered positions

- **Keep the Asus and find the stall cause** (Defender exclusions, power settings,
  Beeper). Cheapest, and worth doing anyway, but it leaves production on the less
  reliable machine.
- **Railway, Fly or Render with managed Postgres.** More reliable hardware, but
  conversation data moves to a third party, it adds a recurring cost beyond the test
  budget, and the container still needs Tailscale (and an auth key) to reach the M5 STT.
- **ChatGPT Sites / serverless (ADR-060, `codex/lct-sites-serverless`).** A different
  architecture that is not ready to replace this backend.

## Consequences

- The M5 becomes a single point of failure for both STT and the backend. Today the
  Asus is the single point of failure for the backend while STT stays up, so total
  availability depends on which machine is more reliable; the M5 has been the steadier
  one in the period above.
- The M5 is a laptop: on battery its system sleep is enabled (`sleep 1`), so unplugging
  it can take the backend down. It needs to stay on AC.
- The M5 already runs heavy STT work (load average about 10 during this check). The
  backend's own CPU use is light, but an import now competes with STT for the same CPU.
- Python 3.9 stops being a production constraint.

## Open questions for the owner

1. Approve moving production to the M5 at all.
2. Agreement from the TemporalCoordination lane to disable `lct_backend` in the Asus
   supervisor at cutover.
3. Who changes `VITE_BACKEND_API_URL` in Vercel and the Attendee webhook, and when.
4. A cutover window.
5. Where nightly backups go.
