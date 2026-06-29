# Plan: DB-Integration Test Suite for LCT Backend Write Paths

**Date:** 2026-06-29
**Status:** Scoped, awaiting build
**Scope decision:** P0 + P1 (~20–25 tests, ~2.5 days) + wire into CI
**Follows:** PR #124 (366 unit tests — all zero-DB pure-logic and route-contract coverage)

## Why this exists

PR #124 covered everything testable without a database: model constraints (class-level
ORM inspection), route contracts (TestClient + dependency_overrides), and pure helpers.
What remains is the **DB write layer** — the functions that materialize graphs, ingest
transcripts, and checkpoint imports. These carry the real data-loss risk and can only be
tested against a real Postgres because they exercise FK cascades, CHECK constraints, and
destructive delete-before-insert behavior that mocks cannot reproduce.

## Foundational constraint (shapes the whole design)

`persist_graph` and `persist_turns` **call `db.commit()` internally**. The clean
"wrap each test in a transaction, roll back at teardown" isolation pattern therefore
**cannot work** — the function under test commits before the test can roll back.

**Consequence:** the suite must follow the existing model — commit real rows, then
delete them in a `finally` using `ITEST-<uuid>`-prefixed identifiers (cascade-delete the
Conversation; FK `ON DELETE CASCADE` cleans children). This matches the 4 existing
`tests/integration/*_pg.py` files.

## Existing infrastructure (reuse, don't rebuild)

| Fact | Detail |
|---|---|
| Real-PG tests today | `tests/integration/test_persist_turns_pg.py`, `test_coverage_linking_pg.py`, `test_import_turns_endpoint.py`, `test_subject_review_pg.py` |
| Gating | Module-level `pytestmark = pytest.mark.skipif(not os.getenv("DATABASE_URL"))` |
| Async driver | **No pytest-asyncio.** Manual `asyncio.run(scenario())`; each file builds its own engine inline via `_async_url()` (`postgresql://` → `postgresql+asyncpg://`, `connect_args={"ssl": False}` for the Windows proactor loop) |
| Schema | Alembic `alembic upgrade head` (NOT `create_all`); `env.py` reads `DATABASE_URL` |
| DB URLs | Local `127.0.0.1:5432/lct_dev`; CI Postgres `localhost:5433/lct_dev` |
| Cleanup | `ITEST-<uuid>` / `ITEST-AN-` / `ITEST-SR-` prefixes; `finally` cascade-delete |
| Pytest config | **None** — no pyproject/pytest.ini; only marker registration in `tests/conftest.py` |
| CI | Does **not** run pytest. `.github/workflows/e2e.yml` boots `postgres:15`, runs `alembic upgrade head`, starts uvicorn, runs Playwright only |
| Run command | `cd lct_python_backend && ..\.venv\Scripts\python -m pytest tests/integration/<file> -v` with `DATABASE_URL` exported |

## Infrastructure to build (the only new scaffolding)

**`tests/integration/conftest.py`** — one shared async-PG fixture so each test isn't 30
lines of engine boilerplate:
- `pg_engine` (session-scoped): `create_async_engine` from `DATABASE_URL`, `ssl=False`,
  skip the whole module if unset.
- `pg_session` (function-scoped): yields an `AsyncSession(expire_on_commit=False)`.
- `itest_owner` (function-scoped): unique `owner_id = f"ITEST-{uuid4().hex[:12]}"` +
  registers a teardown that cascade-deletes every Conversation for that owner.
- Helper `seed_conversation(session, owner_id, ...)` and `read_nodes/read_edges`
  thin wrappers so assertions read cleanly.

Keep the manual-`asyncio.run` style OR adopt the fixture — **recommendation: adopt the
fixture** (cleaner, and the fixture can still drive coroutines). Do not add pytest-asyncio
unless a later phase needs it; the fixture + explicit `await` inside an `asyncio.run`
wrapper matches house style.

## Test targets (P0 + P1)

### P0 — destructive paths that can silently wipe real graphs

**T1. `persist_graph` delete-before-insert** (`graph_persistence.py:477`)
- Seed a conversation with Nodes + Relationships. Call `persist_graph` with a *different*
  `existing_json`. Assert: old Node/Relationship rows are gone, new ones present, counts match.
- Assert the **danger case**: empty `existing_json` *with* `utterances` passed proceeds past
  the `L515` guard and deletes nodes (documents the data-loss footgun, not just happy path).
- Assert `total_nodes` on the Conversation row updates correctly.

**T2. `persist_graph` resume path (`protect_node_ids`)** (`graph_persistence.py:550`)
- Seed nodes; call with `protect_node_ids = {subset}`. Assert protected nodes survive,
  unprotected deleted, and relationships among deleted nodes drop via `ondelete=CASCADE`.
- Assert protected IDs and `existing_json` IDs are disjoint (the documented invariant).
- This is the **live-recording resume** path — highest live-traffic risk.

**T3. `persist_turns` analysis-cascade ordering** (`graph_persistence.py:334`) — *regression anchor*
- Already covered by `test_persist_turns_pg.py`. Add one assertion that re-ingest of an
  existing `(owner, group_id)` deletes `SimulacraAnalysis`/`BiasAnalysis`/`FrameAnalysis`
  BEFORE `Node` (they FK `nodes.id` without `ON DELETE CASCADE`) — guards the manual
  ordered-delete that's easy to regress.

### P1 — silent fidelity / correctness loss

**T4. Faithful `edges_out` vs legacy lossy relationship path** (`graph_persistence.py:1011`)
- Round-trip a graph whose nodes carry `edges_out` with `strength`/`confidence`/`subtype`/
  `bidirectional`/`supporting_utterance_ids`. Persist → read via
  `build_graph_data_from_nodes(..., include_edges_out=True)` → assert no field loss.
- Persist a graph **without** `edges_out` (legacy path) → assert it falls to temporal +
  contextual only and re-mints relationship IDs (documents the lossy path).
- Pin the `include_edges_out=False` default footgun with an explicit assertion.

**T5. `graph_query_service` tier filtering + cross-tier edge drop** (`graph_query_service.py:120/130`)
- Seed nodes across tiers (`zoom_level_visible`). Call `load_nodes_for_conversation(zoom_level=N)`
  → assert only matching-tier nodes returned, ordered by `timestamp_start nullslast`.
- Seed an edge whose endpoints span two tiers; load tier-filtered node set then
  `load_edges_for_nodes` → assert the cross-tier edge is **silently dropped** (both
  endpoints must be in the node set). Documents the known UX gap.

**T6. `extract_graph_for_conversation` — Phase-2 extract** (`import_orchestrator.py:145`)
- Phase 1: `persist_turns` to seed Utterances with `source_identifier`. Phase 2: call
  `extract_graph_for_conversation` (extractor stubbed to return a known graph) → assert
  Nodes/Relationships written AND **Utterance rows untouched** (re-runnable property).
- Run it twice → assert idempotent-ish (nodes rewritten, utterances stable). Zero
  coverage today.

## CI wiring (chosen)

Add a `pytest-integration` job to `.github/workflows/` (or extend `e2e.yml`):
- Reuse the existing `postgres:15` service (port 5433) + `alembic upgrade head` steps.
- `cd lct_python_backend && python -m pytest tests/integration -v` with
  `DATABASE_URL=postgresql://lct_user:lct_password@localhost:5433/lct_dev`.
- Install `requirements.txt` + `asyncpg` (anaconda lacks it per project memory; CI uses
  clean venv so just ensure it's in requirements).
- Gate: only the `*_pg.py` + new integration tests; skip-gating means a missing DB is a
  skip, not a failure — but in CI the DB is present so they actually run.

## Out of scope (deferred to a P2 follow-up)

- `persist_import_pipeline_results` non-fatal graph-persist swallow (telemetry-flag path)
- `record_pipeline_artifact` exception swallow
- `persist_transcript` / `parse_validate_and_persist`
- `persist_live_graph_snapshot` (currently faked in `test_transcripts_websocket.py`)
- `run_bulk_processing_worker` end-to-end SSE
- `save_chunk_checkpoint` / `clear_checkpoint` (has `test_import_checkpoint.py` — verify harness first)

## Effort

| Phase | Work | Est |
|---|---|---|
| Infra | `integration/conftest.py` shared fixture + helpers | 0.5 d |
| P0 | T1–T3 (destructive delete, resume, cascade anchor) | 1.0 d |
| P1 | T4–T6 (edge fidelity, tier filtering, Phase-2 extract) | 1.0 d |
| CI | Postgres pytest job + requirements | 0.5 d |
| **Total** | **~20–25 tests** | **~3.0 d** |

Lands as one PR using the `*_pg.py` naming convention (skip-gated; never breaks a
machine without a DB), reviewed by codex + grok before merge per session convention.
