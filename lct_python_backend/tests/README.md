# Backend Tests

Last audited: 2026-07-04

Backend tests use `pytest`, `pytest-asyncio`, and `pytest-cov` from
`lct_python_backend/requirements.txt`.

## Layout

```text
tests/
|-- unit/               focused service/router/helper tests
|-- integration/        DB/WebSocket/import/STT contract tests
|-- live_prayer/        live-prayer detector/runner/fact-check tests
|-- synthesis/          grounded synthesis tests
|-- fixtures/           sample transcripts and golden datasets
|-- test_*.py           older top-level tests still collected by pytest
|-- conftest.py         shared fixtures
`-- invariants.py       system-invariant helpers
```

## Run

From the repo root:

```bash
./.venv/bin/python -m pytest -q lct_python_backend/tests/unit
./.venv/bin/python -m pytest -q lct_python_backend/tests/integration
./.venv/bin/python -m pytest -q lct_python_backend/tests
```

From inside `lct_python_backend/`:

```bash
PYTHONPATH=. ../.venv/bin/python -m pytest -q tests/unit
PYTHONPATH=. ../.venv/bin/python -m pytest -q tests/integration
```

Coverage:

```bash
../.venv/bin/python -m pytest tests --cov=lct_python_backend --cov-report=term-missing
```

## Important Test Groups

- STT/live runtime: `tests/unit/test_stt_*.py`,
  `tests/integration/test_transcripts_*.py`,
  `tests/integration/test_streaming_audio_http_e2e.py`.
- Import pipeline: `tests/unit/test_import_*.py`,
  `tests/integration/test_import_turns_endpoint.py`,
  `tests/integration/test_persist_turns_pg.py`.
- Graph/artifact/share: `tests/unit/test_graph_api_contract.py`,
  `tests/unit/test_artifact_*.py`, `tests/unit/test_share_api*.py`.
- Privacy/egress: `tests/unit/test_egress_*.py`,
  `tests/unit/test_privacy_boundary.py`.
- Subject review: `tests/unit/test_subject_review_*.py`,
  `tests/integration/test_subject_review_pg.py`.
- Synthesis: `tests/synthesis/`.
- Live prayer: `tests/live_prayer/`.

## Optional Smoke Tests

These tests are not ordinary offline unit tests; run them only when the required
services and fixtures are available.

- `tests/integration/test_whisper_ws_smoke.py`
  - set `RUN_WHISPER_WS_SMOKE_TEST=1`
  - requires `WHISPER_WS_URL`, `WHISPER_PCM_PATH`
  - optional knobs include `WHISPER_CHUNK_SIZE`,
    `WHISPER_MAX_BYTES`/`WHISPER_MAX_SECONDS`, `WHISPER_SKIP_SECONDS`,
    `WHISPER_STOP_ON_TEXT`, `WHISPER_CHUNK_TIMEOUT`,
    `WHISPER_FINAL_TIMEOUT`, `WHISPER_STREAM_SPEED`,
    `WHISPER_PING_INTERVAL`, `WHISPER_PING_TIMEOUT`
- `tests/integration/test_transcribe_proxy_smoke.py`
  - set `RUN_TRANSCRIBE_PROXY_SMOKE_TEST=1`
  - requires `TRANSCRIBE_PROXY_AUDIO_PATH`
  - optional knobs include `TRANSCRIBE_PROXY_URL`,
    `TRANSCRIBE_PROXY_LANGUAGE`, `TRANSCRIBE_PROXY_DIARIZE`,
    `TRANSCRIBE_PROXY_TIMEOUT`

## Invariants

See `docs/adr/ADR-007-system-invariants-data-integrity.md` and
`tests/invariants.py` for the invariant vocabulary. Tests should protect
observable behavior: persisted rows, API contracts, graph/artifact shapes,
WebSocket messages, and descriptive failures.
