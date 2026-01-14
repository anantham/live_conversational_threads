# Testing Infrastructure - README

## Test Coverage Status

### Phase 1: Infrastructure Setup ✅ COMPLETE

**Completed:**
- ✅ Test directory structure created (`fixtures/`, `unit/`, `integration/`, `e2e/`, `performance/`)
- ✅ `tests/invariants.py` implemented with all 14 system invariants
- ✅ `tests/conftest.py` created with pytest fixtures and mock infrastructure  
- ✅ Golden dataset fixture created (`expected_nodes.json`)
- ✅ First test file created: `test_data_completeness.py`

**Verification:**
```bash
cd lct_python_backend
python3 -c "from tests.invariants import check_all_invariants; print('✓')"
```

---

## Running Tests

### All Tests
```bash
cd lct_python_backend
.venv/bin/python3 -m pytest tests/ -v
```

### Specific Test Module
```bash
.venv/bin/python3 -m pytest tests/unit/test_data_completeness.py -v
```

### With Coverage
```bash
.venv/bin/python3 -m pytest tests/ --cov=. --cov-report=html
```

---

## Test Categories

### Unit Tests (`tests/unit/`)
- **test_data_completeness.py** - INV-1.x (utterance → node mapping, timeline, aggregation)
- **test_zoom_aggregation.py** - INV-6.x (zoom visibility, aggregation logic) [TODO]
- **test_audio_processor.py** - INV-2.x (audio capture, silence detection) [TODO]

### Integration Tests (`tests/integration/`)
- **test_audio_to_transcript_pipeline.py** - Full audio → transcript flow [TODO]
- **test_websocket_communication.py** - WebSocket health checks [TODO]
- **test_whisper_ws_smoke.py** - Optional smoke test for Whisper WS (set `RUN_WHISPER_WS_SMOKE_TEST=1`, `WHISPER_WS_URL`, `WHISPER_PCM_PATH`, optional `WHISPER_CHUNK_SIZE`, `WHISPER_MAX_BYTES`/`WHISPER_MAX_SECONDS`, `WHISPER_SKIP_SECONDS`, `WHISPER_STOP_ON_TEXT`, `WHISPER_CHUNK_TIMEOUT`, `WHISPER_FINAL_TIMEOUT`, `WHISPER_STREAM_SPEED`, `WHISPER_PING_INTERVAL`, `WHISPER_PING_TIMEOUT`)

### E2E Tests (`tests/e2e/`)
- **test_full_audio_pipeline.py** - Complete flow validation [TODO]

### Performance Tests (`tests/performance/`)
- **test_latency_metrics.py** - INV-2.3, INV-5.x (latency, instrumentation) [TODO]

---

## System Invariants Reference

See [ADR-007](../docs/adr/ADR-007-system-invariants-data-integrity.md) for full details.

**Data Completeness:**
- INV-1.1: Every utterance → node at zoom 1
- INV-1.2: Timeline contains all utterances
- INV-1.3: No utterances lost in aggregation

**Audio Pipeline:**
- INV-2.1: Recording state consistency
- INV-2.2: Non-silent audio detection
- INV-2.3: Transcription latency < 10s (P95)

**Speaker Diarization:**
- INV-3.1: Participant count consistency
- INV-3.2: Speaker ID stability

**Graph Structure:**
- INV-4.1: No dangling edges
- INV-4.2: Temporal edge ordering

**Instrumentation:**
- INV-5.1: All API calls logged
- INV-5.2: Metrics freshness < 5s

**Zoom System:**
- INV-6.1: Zoom visibility hierarchy
- INV-6.2: Aggregates contain children

---

## Next Steps

1. ✅ ~~Phase 1: Infrastructure Setup~~
2. **Phase 2: Critical Path Tests** (Audio Pipeline)
   - Create `test_audio_websocket.py`
   - Create `test_diarization.py`
3. **Phase 3: Zoom System Tests**
   - Create `test_zoom_aggregation.py`
4. **Phase 4: CI/CD Integration**
   - Set up GitHub Actions workflow
