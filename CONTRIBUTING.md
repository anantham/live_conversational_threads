# Contributing to Live Conversational Threads

Welcome. This repo is a personal research instrument (see [PRODUCT.md](PRODUCT.md)) built
at unusual velocity by its owner plus a fleet of AI coding agents working in parallel.
That shapes almost everything you'll notice about it — the density of docs, the number of
in-flight branches, and the etiquette below. This guide is for **human collaborators**
trying to make sense of it.

## Orient yourself in ~15 minutes

Read in this order:

1. **[README.md](README.md)** — what this is and why it exists (the pre-formal
   "prayers" layer, the 5-layer stack). 3 minutes.
2. **[PRODUCT.md](PRODUCT.md)** — who it's for, the design register (calm, dense,
   contemplative), the anti-references. 3 minutes.
3. **[docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)** — the map: every backend
   router, service module, and frontend page in one file. Skim it, keep it open. 5 minutes.
4. **[docs/adr/INDEX.md](docs/adr/INDEX.md)** — the architecture actually lives in the
   ADRs (Architecture Decision Records). Skim the index; read a specific ADR only when
   you touch its area. 2 minutes.
5. **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)** — naming, patterns, and style ground
   truth before you write code.

Two more when you need them: [AGENTS.md](AGENTS.md) (the working protocol — TDD
expectations, commit granularity, error-correction rules; written for AI agents but the
norms apply to humans too) and [ISSUES.md](ISSUES.md) (known bugs and tech-debt ledger).

## Setup

- **macOS:** double-click `setup-once.command` (first time), then `start.command`
  (every time). Details: [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).
- **The LLM runs separately** — have Ollama (or LM Studio / a remote box) running with a
  model pulled. Settings → Runtime shows live backend status.
- Backend env config lives in `lct_python_backend/.env` (created from `.env.example`).

## Running tests

```bash
# Backend unit tests (fast, no DB)
python -m pytest lct_python_backend/tests/unit

# Backend integration tests (need a live Postgres + `alembic upgrade head` first)
python -m pytest lct_python_backend/tests/integration

# Frontend
cd lct_app && npm test          # vitest unit tests
cd lct_app && npm run test:e2e  # Playwright e2e
```

More detail (fixtures, DB harness, what to test vs not): [docs/TESTING.md](docs/TESTING.md)
and the TEST_DESIGN_PRINCIPLES section of [AGENTS.md](AGENTS.md).

Honest caveat: running the *entire* backend unit suite in one invocation currently hits
some cross-file test-pollution failures (`sys.modules` stubbing collisions between files).
Individual files and directories run green. If a failure looks unrelated to your change,
re-run that test file alone before assuming you broke it.

## Making changes

1. **Check the ADRs first.** If your change touches an architectural decision, the
   relevant ADR is the context you need — and if it *reverses* one, write a new ADR
   rather than silently diverging. New ADRs take the next free number after the highest
   in [docs/adr/INDEX.md](docs/adr/INDEX.md) (never backfill gap numbers — they're
   burned; see the index's notes), and get a row in the index in the same PR.
2. **Branch from `main`, PR back to `main`.** Conventional-commit messages
   (`feat:`, `fix:`, `docs:`, `refactor:` …). Small, atomic, reviewable commits — see
   AGENTS.md's "What to commit" section.
3. **Tests accompany the change.** Bug fixes come with a test that fails without the fix.
4. **Privacy is load-bearing, not decorative.** This app handles real conversation
   transcripts and voice data. Anything that sends data off-machine goes through the
   established chokepoints (ADR-034-egress / ADR-038); never add a direct outbound call
   from feature code, and never commit real transcripts, audio, exports (`*.threads*`),
   or `.env*` files.

## The multi-agent workshop (read this — it will confuse you otherwise)

Several AI agent sessions often work in this repo **at the same time**, coordinated
loosely via worktrees and presence messages. Practical consequences for you:

- **A dirty `git status` on `main` is normal.** Uncommitted modifications you don't
  recognize are usually another session's work-in-progress. Don't commit, stash, revert,
  or "clean up" files you didn't touch — someone is probably mid-task in them.
- **Real work happens in worktrees** under `.claude/worktrees/<task-name>`, one branch
  per task, so parallel tasks can't collide. If you're doing more than a one-line fix,
  consider the same: `git worktree add .claude/worktrees/my-task -b my-branch origin/main`.
- **Branches churn.** Expect unfamiliar branches to appear, merge, and vanish. Before
  building on any branch, `git fetch` and check it's still ahead of `main`.
- **Scratch files go in `tmp/`** (gitignored), never the repo root. Older sessions
  littered the root with `.tmp_*` files; that convention is dead — anything matching it
  is safe to treat as debris.

## Why the root directory looks the way it does

A fresh clone is clean. A *running* dev machine accumulates gitignored runtime state at
the root — this is expected, not mess:

| Entry | What it is |
|---|---|
| `.postgres_data/` | The project-local PostgreSQL data dir (your actual database — never delete) |
| `.run/`, `.backend-port` | Supervisor runtime state for the backend on :43181 |
| `logs/` | Backend logs + supervisor scripts (see docs/SUPERVISION.md) |
| `tmp/` | Scratch space for experiments and agent sessions |
| `.claude/`, `.agents/`, `.agent-reviews/` | AI-agent session state, presence, and background code-review output |
| `.env.local`, `lct_python_backend/.env` | Local secrets/config (gitignored — keep it that way) |

Tracked root files are deliberately few: the two app dirs (`lct_python_backend/`,
`lct_app/`), `docs/`, `scripts/`, `attendee_stack/` (meeting-bot Docker stack), the
start/setup commands, and six top-level docs (README, PRODUCT, DESIGN, AGENTS, CLAUDE,
ISSUES — CLAUDE.md just points agents at AGENTS.md).

## Questions

Open an issue in the tracker, or add a question row to [ISSUES.md](ISSUES.md) in a PR if
it's a "this doc contradicts that code" discovery — those are treated as real bugs here.
