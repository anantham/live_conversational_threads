---
Date: 2026-06-23
Status: **Proposed — design for review.** Tier 0 (observability) is BUILT (this branch: `/api/version` + warn-by-default canonical-python guard). Tier 1 (supervisor correctness) and Tier 2 (single authority + lease) are NOT implemented; this ADR specifies them for review before any change to the shared `start_all.py` supervisor. Motivated by a real restart-storm (2026-06-22) and a codex + grok dual review.
Group: Infra / Process supervision / Multi-session ops
Related: ADR-034 (egress chokepoint — the network gate; orthogonal but co-resident in the same backend lifespan); IndrasNet supervisor `grimoire/IndrasNet/scripts/start_all.py` (the fleet launcher this constrains); memory `lct-backend-port-ownership-storm` (the incident + the codex/grok review); `lct-backend-supervisor-adopt-unowned-trap`, `tc-supervisor-orphan-port-bug` (prior observations of the same surface).
---

# ADR-040: Backend Port Ownership & Restart Authority (:43181)

> The LCT backend on TCP **:43181** is a singleton service, but on this box **two independent managers** (the IndrasNet supervisor and ad-hoc agent/session launchers) may both try to own it, with **different desired runtimes** (`.venv` vs anaconda). "Restart" is implemented as *tree-kill the port holder and hope my relaunch wins the bind* — which, under contention, is a race. This ADR makes ownership **explicit, verified, and single-authority**.

## Issue

On 2026-06-22, after merging 5 PRs and `git pull`-ing the live checkout, an agent wrote the supervisor's restart sentinel (`echo lct_backend > <IndrasNet>/logs/RESTART_REQUESTED`) to load the new code. At that moment an **anaconda** uvicorn was serving :43181 and the supervisor had **adopted it UNOWNED**. The sentinel forced the supervisor's takeover (reclaim) path; what followed was a multi-minute **restart-storm**: backends came up, held ~40–60s, then died; `.venv` launches repeatedly lost the bind race to a recurring anaconda backend; the supervisor hit `MAX_RESTART_ATTEMPTS=5` and gave up. The service eventually stabilised — on anaconda — by luck, not design. It also took ~10 manual steps to even answer "is the merged code now live?".

## Context — what exists today (grounded in `start_all.py`)

- **Configured runtime.** `AGENTS["lct_backend"]` (`start_all.py:179`) launches uvicorn with the LCT repo's `.venv` interpreter, `cwd` = the LCT checkout, `port` = 43181, `health_url` = `/api/import/health`.
- **Adopt-unowned.** In `start_agent` (`start_all.py:532-673`): if the port is in use and the health probe is OK and `crash_counts == 0`, the supervisor logs "adopted, unowned" and `return True` **without storing a process handle** (`:591-599`). It is *accepted*, not supervised — after this it is invisible to the `wait()` poll loop and never health-checked again.
- **Reclaim.** If the port is in use, healthy, and `crash_counts > 0`, it takes the orphan pid from `_pid_listening_on_port(port)` and `_kill_process_tree`s it, waits 30×0.1s (~3s) for the port to free, then falls through to launch (`:567-589`). **It kills by PORT, not by ownership** — no check that the killed pid is this supervisor's, the expected interpreter, or the expected cwd.
- **The verified gap.** After `Popen`, `start_agent` calls `_wait_for_agent_ready` (which probes the **port's** `health_url`) and on success `return True` (`:654-666`). **It never verifies that `_pid_listening_on_port(port) == process.pid`.** So if a rival wins the bind in the kill→listen gap, the supervisor sees the rival's green health, believes its own launch succeeded, then its real child exits → `wait()` counts it as a crash → repeat. **This is the precise mechanism of the 40–60s flap** — a race the supervisor cannot even see, because it conflates "something healthy is on the port" with "I own the port."
- **Sentinel.** `_process_restart_flag` (`start_all.py:1123-1213`) reads `RESTART_REQUESTED`, whose content names a target (any `AGENTS` key) or defaults to `web_server`. For a named, port-holding, *unowned* target it forces `crash_counts = max(1, …)` so `start_agent` takes the reclaim branch ("takeover"). The single file is overloaded (web_server reload AND lct takeover; concurrent writers last-writer-wins).
- **Crash guard.** `MAX_RESTART_ATTEMPTS = 5` (`:58`); after that the agent stops being restarted. *(Reviewers note the give-up/defer behaviour is asymmetric — only `web_server` is deferred after MAX; `lct_backend` simply stops. This ADR treats that as a to-verify item, not a settled fact.)*
- **Competing launcher.** `live_conversational_threads/logs/start_lct_backend.ps1` directly `Start-Process`-es a `.venv` uvicorn on 43181 (refusing only if the port is already held). It is a *second* manager that binds the port directly.
- **Already shipped (Tier 0, this branch).** `GET /api/version` (unauthenticated) reports `{git_sha (captured at process start), git_dirty, python_executable, pid, cwd, started_at, canonical_python}`; a lifespan guard WARNs on a non-`.venv` interpreter (enforce under `LCT_REQUIRE_CANONICAL_PYTHON`).

## Root cause

A singleton network service with a *specific desired runtime* is treated as a shared resource that **any** process may start, while the supervisor's ownership model is **implicit and best-effort** (port-in-use + a point-in-time health probe) with a **violent, unverified** "kill + hope I win" transition. Adopt-unowned keeps the peace only until someone forces a reclaim; then two managers with different desired runtimes fight over a first-come-first-served port.

## Decision

Make ownership **explicit, recorded, verifiable, and single-authority**. Ownership is asserted by the **live process** (the only thing that truly knows it bound and is serving); every launcher — including the supervisor — is a *client* of ownership that must (a) request rather than blindly start, (b) verify it actually won after starting, and (c) refuse to murder a holder whose identity it can't account for.

### Tier 0 — Observability (BUILT, this branch)
Prerequisite for everything else: you cannot arbitrate ownership you cannot observe.
- `GET /api/version` answers "which code / interpreter / process is serving :43181?" in one tokenless call.
- Canonical-python guard: warn by default; `LCT_REQUIRE_CANONICAL_PYTHON=1` makes a wrong-env process **fail fast** (so it can never become a "healthy" competitor). Enforcement is intentionally opt-in — flipped on as part of Tier 2, not before, so it cannot strand the live service.

### Tier 1 — Supervisor correctness (small diffs to `start_all.py`)
1. **Post-launch ownership verification.** After `_wait_for_agent_ready`, assert `_pid_listening_on_port(port) == process.pid`; if not, kill ours, drop the handle, `return False`. Turns a silent later-crash into an immediate, logged "lost the bind race" — and is the single highest-value supervisor fix (it directly kills the flap).
2. **Identity-checked reclaim.** Before `_kill_process_tree` on a port holder, compare its `ExecutablePath` / `cwd` to the expected `.venv` / LCT root. On mismatch, record `CONFLICT_EXTERNAL_OWNER` and **do not auto-kill** — surface it instead of murdering a rival manager's process.
3. **Track adopted-unowned.** Put adopted instances in an `externally_managed` set that is still health-polled, so a later death/wedge is visible (today it goes dark after adoption).
4. **Disambiguate the sentinel** (optional): per-target request files or a structured request, so web_server reload and lct takeover don't share one last-writer-wins file.

### Tier 2 — Single authority + real lease (needs build + its own review)
1. **Request-only launchers.** `start_lct_backend.ps1` (and any documented manual path) become **request-only**: write the restart sentinel; never `Start-Process` uvicorn on 43181. Parallel sessions request a restart through the one authority; they never bind the port.
2. **A real lease — a lock, not a JSON file.** The backend asserts ownership in its lifespan **after binding** via an actual held lock (a held file-lock / named mutex, or a wrapper process that holds the lock for uvicorn's lifetime), recording pid / interpreter / cwd / git_sha. A plain JSON metadata file is **observability, not mutual exclusion** — check-then-bind is a TOCTOU race (two launchers pass the same check, both bind). Launchers consult the lease (pid alive AND still the listener) and refuse if valid; clean a provably-stale lease before proceeding.
3. **Cooperative yield.** The backend watches the restart request and performs a **graceful self-shutdown** when asked, so the owner *yields* and the requester binds cleanly — instead of a blind kill + bind race.
4. **Enforce canonical python** (`LCT_REQUIRE_CANONICAL_PYTHON=1`) once all known launch paths use `.venv`, so a stray anaconda invocation fails fast rather than competing.
5. **`diagnose_stack.py`** reports :43181's listener pid / exe / cwd / cmdline and includes `lct_backend` in singleton checks (would have made the anaconda manager obvious immediately).

## Consequences / rollout
- Tier 0 is live-safe and shipped now; it changes no supervisor behaviour and adds one tokenless read-only endpoint.
- Tier 1 is a few targeted diffs that make the supervisor's side observably correct; it reduces (does not eliminate) contention.
- Tier 2 is the actual root-cause fix (single authority); it changes multi-session behaviour and must not be improvised — hence this ADR. The enforcement flip (canonical python) lands only once every launcher is request-only, or it could strand the service.
- Net: ownership shifts from "supervisor sometimes owns via adoption or violent reclaim" to "the live process asserts ownership; launchers respect it, verify after start, and contest only with proof."

## Alternatives considered
- **Keep kill-and-hope.** Rejected: it is the bug — unverified, racy under any second manager.
- **JSON lease file (the first proposal).** Rejected as the *mechanism*: metadata without a held lock is a TOCTOU race. Kept as the *payload* carried by a real lock.
- **Adopt-unowned everywhere.** Rejected for a declared backend with its own interpreter: it collapses "compatible owner", "wrong-env-but-healthy", and "unknown rival" into one state and then stops supervising. Acceptable only for non-critical, port-less agents.
- **Make every launcher honour a soft lease (no lock).** Rejected: a launcher that doesn't know about the lease still wins binds; only request-only + a real lock + app-level canonical guard close the race.

## Design review history
- **2026-06-22, codex + grok dual review** (headless; prompts/outputs in the session). Both independently confirmed the root cause and — crucially — both surfaced the **missing post-launch pid-ownership check** that this author had missed; it was then verified directly in `start_agent`. Both corrected the original "lease = JSON file" proposal to "lease must be a real lock", and expanded `/api/version` to include the interpreter path (the actual `.venv`/anaconda discriminator). grok added the **app-level canonical-python guard** (fail-fast wrong-env), now shipped as Tier 0. No false positives found on adjudication. Tooling caveat: codex's `-s read-only` did not prevent it running a `taskkill` on this Windows box (it killed an unrelated stray, not the backend) — do not assume codex read-only is inert against live infra.
- This ADR's implementation (Tier 1/2 code) gets its own dual review before merge.
