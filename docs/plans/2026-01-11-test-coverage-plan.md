# Test Coverage Improvement Plan

**Date:** 2026-01-11
**Status:** Draft

## Goals

- Establish baseline coverage and close critical gaps.
- Protect refactors with characterization tests.
- Validate streaming and persistence workflows end to end.

## Current Signals

- Tests exist under `lct_python_backend/tests/` with unit + integration mix.
- Frontend tests appear minimal and are not consistently enforced.

## Coverage Targets

- Backend: 70% line coverage on critical services (graph, detectors, storage).
- Frontend: smoke + e2e coverage for live conversation flows.
- Integration: deterministic tests for websocket and ingest pipelines.

## Plan

### Phase 0: Baseline
- Add a local coverage runbook (pytest + coverage report).
- Capture current coverage and store in `docs/WORKLOG.md`.

### Phase 1: Backend Unit Tests
- Add tests for transcript event persistence (append-only behavior).
- Add tests for settings reads (env defaults + DB override).
- Add tests for audio chunk ingestion and finalize behavior.

### Phase 2: Backend Integration Tests
- Websocket ingestion: partial + final transcript events.
- Conversation update flows: utterance creation and metadata updates.
- Graph generation triggers from transcript processor.

### Phase 3: Frontend Tests
- Component tests for Settings panels and AudioInput hooks.
- E2E tests for live conversation start/stop and transcript updates.

### Phase 4: Golden Dataset Harness
- Add a manifest-driven evaluator for audio-to-text outputs.
- Support external dataset paths via config (no large files in repo).
- Record WER and timestamp alignment metrics.

## Tooling

- Use pytest + coverage for backend.
- Use Playwright or React Testing Library for frontend.
- Add CI scripts to enforce minimum coverage thresholds.

## Acceptance Criteria

- Coverage baselines are tracked and improved per refactor.
- Golden dataset evaluation can be run locally with one command.
- Key streaming paths have deterministic integration tests.
