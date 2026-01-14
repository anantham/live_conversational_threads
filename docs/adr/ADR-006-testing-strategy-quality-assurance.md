# ADR-006: Testing Strategy and Quality Assurance Framework

**Status:** Proposed  
**Date:** 2025-11-27  
**Author:** Aditya Adiga  
**Deciders:** Aditya Adiga

---

## Context

The Live Conversational Threads platform is evolving from static Google Meet transcript import to real-time audio capture with live transcription and speaker diarization. This shift introduces new complexity in the audio capture pipeline, real-time processing, and user feedback mechanisms. We need a comprehensive testing strategy that:

1. **Ensures Audio Pipeline Reliability**: Users must receive clear feedback that recording is working (not capturing silence)
2. **Verifies Data Completeness**: Every utterance must become a node at the highest resolution zoom level
3. **Validates Speaker Diarization**: Correct speaker labeling and participant tracking
4. **Provides Instrumentation**: Track metrics for latency, storage, and costs
5. **Prevents Regressions**: As bugs are fixed, tests should prevent their reoccurrence

### Current State

Existing tests cover:
- Google Meet parser (`test_google_meet_parser.py`)
- Graph generation (`test_graph_generation.py`)
- AI services (bias detection, frame detection, Simulacra detection)
- Cost calculator (`test_cost_calculator.py`)
- Instrumentation (`test_instrumentation.py`)
- Integration tests (`test_integration_all_features.py`)
- E2E frontend tests (`tests/e2e/`)

**Gaps:**
- ❌ No tests for audio capture WebSocket pipeline
- ❌ No tests for real-time transcription feedback
- ❌ No tests for diarization pipeline
- ❌ No tests for zoom level node aggregation
- ❌ No performance/load tests
- ❌ No UI state feedback validation

---

## Decision

### Core Testing Philosophy

**Priority-Based Coverage:**
- **P0 (Critical Path)**: Audio → Transcript → Visualization - **Target: 95%+ coverage**
- **P1 (Core Features)**: Speaker analytics, zoom system, edit history - **Target: 85%+ coverage**
- **P2 (Advanced Features)**: Simulacra detection, bias detection - **Target: 70%+ coverage**

**Test-Driven Expectations vs Goodharting:**
- Tests document **expected behavior**, not just pass/fail metrics
- Tests may initially **fail** - that's acceptable and informative
- Write **regression tests** when bugs are fixed, not preemptively
- Focus on **integration and E2E tests** over excessive unit tests
- Tests should **surface errors**, not hide them

### Test Categories

#### 1. Audio Capture Pipeline Tests (P0)
**Objective:** Ensure recording button → audio capture → transcription works reliably

**Test Cases:**
```python
# Backend: tests/test_audio_websocket.py
test_websocket_connection_established()
test_audio_permission_granted()
test_audio_data_received_not_silence()
test_transcript_generated_from_audio()
test_recording_state_transitions()
test_websocket_error_handling()
```

**UI Feedback Tests:**
```typescript
// Frontend: tests/e2e/audio-recording.spec.ts
test('recording button changes color when active')
test('error message shown when permissions denied')
test('transcript appears within 5 seconds of speaking')
test('silence detection shows warning to user')
test('websocket disconnection shows error state')
```

#### 2. Data Completeness Tests (P0)
**Objective:** Verify every utterance becomes a node at highest zoom resolution

**Test Cases:**
```python
# tests/test_data_completeness.py
test_every_utterance_becomes_node()
test_timeline_view_contains_all_utterances()
test_zoom_level_1_shows_sentence_nodes()
test_no_utterances_lost_in_aggregation()
```

#### 3. Speaker Diarization Tests (P0)
**Objective:** Validate speaker labeling and participant tracking

**Test Cases:**
```python
# tests/test_diarization.py
test_speaker_segments_labeled_correctly()
test_participant_count_matches_speakers()
test_speaker_colors_in_legend()
test_alternating_speakers_detected()
```

#### 4. Zoom System Tests (P1)
**Objective:** Ensure zoom levels correctly aggregate nodes

**Test Cases:**
```python
# tests/test_zoom_aggregation.py
test_zoom_level_1_sentence_granularity()
test_zoom_level_2_turn_aggregation()
test_zoom_level_3_topic_clustering()
test_edges_redrawn_on_zoom_change()
test_node_visibility_at_each_level()
```

#### 5. Instrumentation Tests (P1)
**Objective:** Track performance, storage, and cost metrics

**Test Cases:**
```python
# tests/test_metrics.py
test_latency_metrics_recorded()
test_storage_usage_tracked()
test_api_cost_calculated()
test_metrics_persisted_to_db()
```

---

## Testing Infrastructure

### Test Data Strategy

**Synthetic Audio Fixtures:**
- 5-second mono audio files (16kHz, WAV format)
- Multi-speaker conversations with clear speaker changes
- Edge cases: overlapping speech, silence, background noise

**Golden Datasets:**
- 10 Google Meet transcripts (anonymized)
- 5 real audio recordings with known ground truth diarization
- Expected node counts at each zoom level

**Test Database:**
- Separate `lct_test.db` for isolation
- Fixtures loaded via pytest fixtures
- Automatic cleanup after test runs

### Test Frameworks

**Backend (Python):**
- `pytest` for unit and integration tests
- `pytest-asyncio` for WebSocket tests
- `pytest-cov` for coverage reporting
- `factory_boy` for test data generation

**Frontend (TypeScript/React):**
- `Playwright` for E2E tests (already configured)
- `Vitest` for component tests
- `@testing-library/react` for UI component testing

### CI/CD Integration

**GitHub Actions Workflow:**
```yaml
name: Test Suite
on: [push, pull_request]
jobs:
  backend-tests:
    runs-on: ubuntu-latest
    steps:
      - pytest tests/ --cov --cov-report=xml
      - Upload coverage to Codecov
  
  frontend-tests:
    runs-on: ubuntu-latest
    steps:
      - npm run test:unit
      - npx playwright test
```

**Coverage Thresholds:**
- Backend: 85% overall, 95% for critical path (audio pipeline)
- Frontend: 80% overall, 90% for AudioInput component

---

## Consequences

### Benefits

✅ **Clear Quality Gates**: Tests define expected behavior before implementation  
✅ **Fast Feedback**: Automated tests catch regressions immediately  
✅ **Living Documentation**: Tests serve as executable specifications  
✅ **Confidence in Refactoring**: Can safely improve code with test safety net  
✅ **Instrumentation Visibility**: Metrics tracking ensures performance awareness

### Tradeoffs

⚠️ **Initial Time Investment**: Writing tests takes time upfront  
⚠️ **Maintenance Burden**: Tests need updating when features change  
⚠️ **Flaky Tests Risk**: E2E tests may be flaky without proper stabilization  
⚠️ **Test Data Management**: Golden datasets need version control

### Risks

🔴 **Over-Testing**: Too many unit tests can slow development (mitigated by focusing on integration tests)  
🔴 **False Confidence**: Passing tests don't guarantee bugs are absent (mitigated by manual testing)  
🔴 **CI Pipeline Slowdown**: Large test suites can take 10+ minutes (mitigated by parallelization)

---

## Implementation Plan

### Phase 1: Critical Path Tests (Week 1)
1. Create `tests/test_audio_websocket.py` for backend audio pipeline
2. Create `tests/e2e/audio-recording.spec.ts` for UI feedback
3. Set up test fixtures for audio data
4. Verify tests fail initially (document expected behavior)

### Phase 2: Data Integrity Tests (Week 1-2)
1. Create `tests/test_data_completeness.py`
2. Create `tests/test_diarization.py`
3. Define golden datasets with known utterance counts
4. Add assertions for node counts at each zoom level

### Phase 3: Instrumentation Tests (Week 2)
1. Extend `tests/test_instrumentation.py` with latency metrics
2. Add storage usage tracking tests
3. Create dashboard endpoint tests

### Phase 4: CI/CD Integration (Week 2)
1. Configure GitHub Actions workflow
2. Set up coverage reporting
3. Add test status badges to README
4. Configure pre-commit hooks for local testing

---

## Test Skeleton Structure

```
lct_python_backend/tests/
├── __init__.py
├── conftest.py                    # Shared pytest fixtures
├── fixtures/
│   ├── audio/                     # Audio test files
│   │   ├── mono_16khz_5sec.wav
│   │   ├── two_speakers.wav
│   │   └── silence.wav
│   ├── transcripts/
│   └── golden_datasets/
│       └── expected_nodes.json
├── unit/                          # Fast unit tests
│   ├── test_audio_processor.py
│   ├── test_diarization.py
│   └── test_zoom_aggregation.py
├── integration/                   # Multi-component tests
│   ├── test_audio_to_transcript_pipeline.py
│   ├── test_data_completeness.py
│   └── test_websocket_communication.py
├── e2e/                          # Full workflow tests
│   └── test_full_audio_pipeline.py
└── performance/                  # Load and performance tests
    └── test_latency_metrics.py

lct_app/tests/
├── e2e/
│   ├── audio-recording.spec.ts   # NEW: Audio UI tests
│   ├── zoom-system.spec.ts       # NEW: Zoom level tests
│   └── speaker-legend.spec.ts    # NEW: Speaker tracking tests
└── unit/
    └── AudioInput.test.tsx        # NEW: Component tests
```

---

## Acceptance Criteria

- [ ] Audio capture tests verify recording state and data flow
- [ ] UI feedback tests validate button color and error messages
- [ ] Data completeness tests ensure every utterance becomes a node
- [ ] Diarization tests validate speaker labeling
- [ ] Zoom tests verify node aggregation at all 5 levels
- [ ] Instrumentation tests track latency, storage, cost
- [ ] CI/CD runs all tests on every PR
- [ ] Coverage reports show 85%+ for critical paths
- [ ] Tests document expected behavior even if they fail initially

---

## References

- [ROADMAP.md](../ROADMAP.md) - Week 14 testing strategy
- [ADR-003](ADR-003-observability-and-storage-foundation.md) - Instrumentation baseline
- [INSTRUMENTATION.md](../../lct_python_backend/INSTRUMENTATION.md) - Metrics tracking
- Pytest Documentation: https://docs.pytest.org/
- Playwright Documentation: https://playwright.dev/

---

**Next Steps:**
1. Review and approve this ADR
2. Create test fixtures directory structure
3. Implement Phase 1 audio pipeline tests
4. Set up CI/CD workflow
5. Iterate based on test failures and findings
