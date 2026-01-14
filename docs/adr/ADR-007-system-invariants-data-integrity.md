# ADR-007: System Invariants and Data Integrity Rules

**Status:** Proposed  
**Date:** 2025-11-27  
**Author:** Aditya Adiga  
**Deciders:** Aditya Adiga  
**Related:** ADR-006 (Testing Strategy)

---

## Context

As the Live Conversational Threads platform grows in complexity—adding real-time audio capture, speaker diarization, multi-level zoom aggregation, and advanced AI analysis—we need to explicitly define **system invariants**: rules that must ALWAYS hold true, regardless of the code path or feature being used.

These invariants serve as:
1. **Contracts** between components
2. **Test assertions** to validate correctness
3. **Documentation** of expected behavior
4. **Bug detection** mechanisms (invariant violations = bugs)

### Motivation

Without explicit invariants, we risk:
- **Data loss**: Utterances disappearing during aggregation
- **Inconsistent state**: Nodes without corresponding utterances
- **Broken relationships**: Edges pointing to non-existent nodes
- **Silent failures**: Metrics not tracked, errors swallowed

---

## Decision

### Core System Invariants

#### 1. Data Completeness Invariants

##### INV-1.1: Every Utterance Must Become a Node
**Rule:** At zoom level 1 (sentence-level), every utterance in the transcript MUST have a corresponding node.

**Rationale:** This is the highest resolution view. If utterances are lost here, they're lost forever.

**Assertion:**
```python
def assert_utterance_node_completeness(conversation_id: str):
    """Every utterance must map to at least one node at zoom level 1."""
    utterances = db.get_utterances(conversation_id)
    zoom_1_nodes = db.get_nodes(conversation_id, zoom_level=1)
    
    for utterance in utterances:
        assert any(
            utterance.id in node.utterance_ids
            for node in zoom_1_nodes
        ), f"Utterance {utterance.id} has no corresponding node at zoom level 1"
```

**Test:** `test_every_utterance_becomes_node()`

---

##### INV-1.2: Timeline View Contains All Utterances
**Rule:** The timeline view MUST display all utterances in temporal order, with no gaps.

**Rationale:** Timeline is the source of truth for "what was actually said."

**Assertion:**
```python
def assert_timeline_completeness(conversation_id: str):
    """Timeline view must contain all utterances in order."""
    utterances = db.get_utterances(conversation_id, order_by="start_time")
    timeline_data = api.get_timeline_view(conversation_id)
    
    assert len(timeline_data) == len(utterances), \
        f"Timeline has {len(timeline_data)} items but {len(utterances)} utterances"
    
    for i, (timeline_item, utterance) in enumerate(zip(timeline_data, utterances)):
        assert timeline_item["utterance_id"] == utterance.id, \
            f"Timeline order mismatch at position {i}"
```

**Test:** `test_timeline_view_contains_all_utterances()`

---

##### INV-1.3: No Utterances Lost in Zoom Aggregation
**Rule:** When aggregating nodes from zoom level N to N+1, all utterance IDs must be preserved (no deletion, only grouping).

**Rationale:** Aggregation should be lossless—we're just grouping, not discarding.

**Assertion:**
```python
def assert_lossless_aggregation(conversation_id: str, zoom_from: int, zoom_to: int):
    """Aggregation must preserve all utterance IDs."""
    nodes_from = db.get_nodes(conversation_id, zoom_level=zoom_from)
    nodes_to = db.get_nodes(conversation_id, zoom_level=zoom_to)
    
    utterances_from = set()
    for node in nodes_from:
        utterances_from.update(node.utterance_ids)
    
    utterances_to = set()
    for node in nodes_to:
        utterances_to.update(node.utterance_ids)
    
    assert utterances_from == utterances_to, \
        f"Aggregation lost utterances: {utterances_from - utterances_to}"
```

**Test:** `test_no_utterances_lost_in_aggregation()`

---

#### 2. Audio Pipeline Invariants

##### INV-2.1: Recording State Consistency
**Rule:** Recording button state MUST match actual audio capture state.

**States:**
- `not_recording`: Button green, WebSocket closed, no audio data flowing
- `recording`: Button red, WebSocket open, audio data flowing
- `error`: Button shows error state, user notified of specific issue

**Assertion:**
```typescript
function assertRecordingStateConsistency() {
  const buttonState = getRecordingButtonState(); // 'recording' | 'not_recording' | 'error'
  const wsState = getWebSocketState(); // 'open' | 'closed' | 'error'
  const audioFlowing = isAudioDataFlowing(); // true | false
  
  if (buttonState === 'recording') {
    assert(wsState === 'open', "Recording button shows recording but WebSocket is not open");
    assert(audioFlowing, "Recording button shows recording but no audio data flowing");
  }
  
  if (buttonState === 'not_recording') {
    assert(wsState === 'closed', "Button shows not recording but WebSocket is still open");
    assert(!audioFlowing, "Button shows not recording but audio data still flowing");
  }
}
```

**Test:** `test_recording_state_consistency()` (E2E)

---

##### INV-2.2: Non-Silent Audio Detection
**Rule:** If audio is being captured for >5 seconds and amplitude is consistently near zero, warn the user (likely microphone issue).

**Rationale:** Prevent "silent recordings" where user thinks they're recording but mic is muted/broken.

**Assertion:**
```python
def assert_audio_not_silent(audio_buffer: np.ndarray, duration_seconds: float):
    """Audio should have non-trivial amplitude if recording for >5 seconds."""
    if duration_seconds > 5:
        rms_amplitude = np.sqrt(np.mean(audio_buffer ** 2))
        assert rms_amplitude > 0.01, \
            f"Audio amplitude too low ({rms_amplitude:.4f}), likely silent/muted"
```

**Test:** `test_silent_audio_detection()`

---

##### INV-2.3: Transcript Generation Latency
**Rule:** Transcript text MUST appear within 10 seconds of audio being spoken (P95 latency).

**Rationale:** User expects near-real-time feedback that transcription is working.

**Assertion:**
```python
def assert_transcription_latency(conversation_id: str):
    """Measure time from audio sent to transcript received."""
    events = get_instrumentation_events(conversation_id, event_type="transcription")
    
    latencies = [
        event["transcript_received_at"] - event["audio_sent_at"]
        for event in events
    ]
    
    p95_latency = np.percentile(latencies, 95)
    assert p95_latency < 10.0, \
        f"P95 transcription latency {p95_latency:.2f}s exceeds 10s threshold"
```

**Test:** `test_transcription_latency_within_threshold()`

---

#### 3. Speaker Diarization Invariants

##### INV-3.1: Participant Count Consistency
**Rule:** Number of unique speakers in legend MUST equal number of unique speakers in utterances.

**Assertion:**
```python
def assert_participant_count_consistency(conversation_id: str):
    """Legend speaker count must match actual speakers in data."""
    utterances = db.get_utterances(conversation_id)
    unique_speakers = set(u.speaker_id for u in utterances)
    
    legend_speakers = api.get_speaker_legend(conversation_id)
    
    assert len(legend_speakers) == len(unique_speakers), \
        f"Legend shows {len(legend_speakers)} speakers but data has {len(unique_speakers)}"
```

**Test:** `test_participant_count_matches_legend()`

---

##### INV-3.2: Speaker Label Continuity
**Rule:** Speaker IDs must be stable throughout a conversation (no ID changes mid-conversation).

**Assertion:**
```python
def assert_speaker_id_stability(conversation_id: str):
    """Speaker IDs should not change during a conversation."""
    utterances = db.get_utterances(conversation_id, order_by="start_time")
    
    speaker_first_seen = {}
    speaker_last_seen = {}
    
    for i, utterance in enumerate(utterances):
        speaker = utterance.speaker_id
        
        if speaker not in speaker_first_seen:
            speaker_first_seen[speaker] = i
        speaker_last_seen[speaker] = i
    
    # Check no speaker ID "resurrects" after being absent
    for speaker in speaker_first_seen:
        first = speaker_first_seen[speaker]
        last = speaker_last_seen[speaker]
        
        # All utterances between first and last should use consistent ID
        intervening_utterances = utterances[first:last+1]
        other_speakers = set(u.speaker_id for u in intervening_utterances if u.speaker_id != speaker)
        
        # If speaker reappears, ID should be same
        # (This is a simplified check; real check would detect ID swaps)
```

**Test:** `test_speaker_id_stability()`

---

#### 4. Graph Structure Invariants

##### INV-4.1: Edge Validity
**Rule:** Every edge MUST connect two existing nodes (no dangling edges).

**Assertion:**
```python
def assert_no_dangling_edges(conversation_id: str):
    """All edges must point to existing nodes."""
    nodes = db.get_nodes(conversation_id)
    node_ids = set(n.id for n in nodes)
    
    edges = db.get_edges(conversation_id)
    
    for edge in edges:
        assert edge.from_node_id in node_ids, \
            f"Edge {edge.id} has invalid from_node_id: {edge.from_node_id}"
        assert edge.to_node_id in node_ids, \
            f"Edge {edge.id} has invalid to_node_id: {edge.to_node_id}"
```

**Test:** `test_no_dangling_edges()`

---

##### INV-4.2: Temporal Edge Ordering
**Rule:** Temporal edges MUST respect utterance chronological order (no time-traveling edges).

**Assertion:**
```python
def assert_temporal_edge_ordering(conversation_id: str):
    """Temporal edges must follow chronological order."""
    edges = db.get_edges(conversation_id, relationship_type="temporal")
    nodes = {n.id: n for n in db.get_nodes(conversation_id)}
    
    for edge in edges:
        from_node = nodes[edge.from_node_id]
        to_node = nodes[edge.to_node_id]
        
        from_max_time = max(
            db.get_utterance(uid).end_time 
            for uid in from_node.utterance_ids
        )
        to_min_time = min(
            db.get_utterance(uid).start_time
            for uid in to_node.utterance_ids
        )
        
        assert from_max_time <= to_min_time, \
            f"Temporal edge {edge.id} violates chronological order"
```

**Test:** `test_temporal_edges_respect_chronology()`

---

#### 5. Instrumentation Invariants

##### INV-5.1: All API Calls Logged
**Rule:** Every LLM API call MUST be logged to `api_calls_log` table with cost and latency.

**Assertion:**
```python
def assert_all_api_calls_logged(conversation_id: str, expected_call_count: int):
    """Verify all API calls are instrumented."""
    api_logs = db.get_api_calls_log(conversation_id)
    
    assert len(api_logs) == expected_call_count, \
        f"Expected {expected_call_count} API calls, found {len(api_logs)} in logs"
    
    for log in api_logs:
        assert log.cost_usd is not None, f"API call {log.id} missing cost"
        assert log.latency_ms is not None, f"API call {log.id} missing latency"
        assert log.total_tokens is not None, f"API call {log.id} missing token count"
```

**Test:** `test_all_api_calls_instrumented()`

---

##### INV-5.2: Metrics Freshness
**Rule:** Metrics MUST be updated within 5 seconds of underlying event (near-real-time).

**Assertion:**
```python
def assert_metrics_freshness(metric_name: str, event_timestamp: datetime):
    """Metrics should reflect recent events within 5 seconds."""
    metric = get_latest_metric(metric_name)
    
    staleness = datetime.now() - metric.last_updated
    
    assert staleness < timedelta(seconds=5), \
        f"Metric {metric_name} is stale by {staleness.total_seconds():.2f}s"
```

**Test:** `test_metrics_are_fresh()`

---

#### 6. Zoom System Invariants

##### INV-6.1: Zoom Level Visibility
**Rule:** A node visible at zoom level N MUST also be visible at all levels < N (higher detail).

**Rationale:** Lower zoom numbers = more detail. If something is visible at level 3 (topic), it must be visible at level 1 (sentence).

**Assertion:**
```python
def assert_zoom_visibility_hierarchy(conversation_id: str):
    """Nodes visible at higher zoom levels must be visible at lower levels."""
    all_nodes = db.get_nodes(conversation_id)
    
    for node in all_nodes:
        min_visible = node.zoom_level_visible
        
        # Node should be visible at all zoom levels >= min_visible
        for zoom in range(1, 6):
            visible_nodes = db.get_nodes(conversation_id, zoom_level=zoom)
            
            if zoom >= min_visible:
                assert node.id in [n.id for n in visible_nodes], \
                    f"Node {node.id} should be visible at zoom {zoom} (min={min_visible})"
```

**Test:** `test_zoom_visibility_hierarchy()`

---

##### INV-6.2: Aggregate Node Contains Children
**Rule:** If node X at zoom level N aggregates nodes A, B, C from level N-1, then X's utterance_ids MUST be the union of A, B, C's utterance_ids.

**Assertion:**
```python
def assert_aggregate_contains_children(parent_node: Node, child_nodes: List[Node]):
    """Parent node must contain all child utterances."""
    parent_utterances = set(parent_node.utterance_ids)
    child_utterances = set()
    for child in child_nodes:
        child_utterances.update(child.utterance_ids)
    
    assert parent_utterances == child_utterances, \
        f"Parent node utterances {parent_utterances} != union of children {child_utterances}"
```

**Test:** `test_aggregated_nodes_contain_all_children()`

---

## Consequences

### Benefits

✅ **Explicit Contracts**: Invariants document what "correct" means  
✅ **Automatic Bug Detection**: Invariant violations = immediate test failures  
✅ **Regression Prevention**: Once invariants are enforced, they stay enforced  
✅ **Confidence in Refactoring**: Can change implementation as long as invariants hold  
✅ **Onboarding Aid**: New developers learn system rules via assertions

### Tradeoffs

⚠️ **Performance Overhead**: Checking invariants adds runtime cost (use debug mode only)  
⚠️ **Test Maintenance**: Invariants are part of test suite, need updating with features  
⚠️ **False Positives**: Overly strict invariants can flag valid edge cases

---

## Implementation Strategy

### 1. Assertion Utilities
Create reusable assertion functions:
```python
# lct_python_backend/tests/invariants.py

def check_data_completeness_invariants(conversation_id: str):
    """Run all data completeness checks."""
    assert_utterance_node_completeness(conversation_id)
    assert_timeline_completeness(conversation_id)
    assert_lossless_aggregation(conversation_id, zoom_from=1, zoom_to=2)

def check_audio_pipeline_invariants(conversation_id: str):
    """Run all audio pipeline checks."""
    assert_recording_state_consistency()
    assert_transcription_latency(conversation_id)
    # ...
```

### 2. Integration with Tests
Add invariant checks to integration tests:
```python
def test_full_audio_pipeline():
    # Perform audio capture → transcript → visualization
    conversation_id = run_full_pipeline()
    
    # Verify invariants hold
    check_data_completeness_invariants(conversation_id)
    check_speaker_diarization_invariants(conversation_id)
    check_graph_structure_invariants(conversation_id)
```

### 3. Debug Mode Invariant Checking
Enable invariant checks in development:
```python
if settings.DEBUG_MODE:
    # Check invariants after every mutation
    @after_node_creation
    def _check_invariants(conversation_id):
        check_all_invariants(conversation_id)
```

### 4. Invariant Violation Reporting
When invariants fail, provide actionable error messages:
```python
class InvariantViolation(Exception):
    """Raised when a system invariant is violated."""
    def __init__(self, invariant_id: str, message: str, context: dict):
        self.invariant_id = invariant_id
        self.message = message
        self.context = context
        super().__init__(f"[{invariant_id}] {message}\nContext: {context}")
```

---

## Monitoring Invariants in Production

While full invariant checking is too slow for production, we can:

1. **Sample-based checking**: Check 1% of conversations randomly
2. **Canary deployments**: Run invariants on canary traffic
3. **Asynchronous validation**: Queue invariant checks as background jobs
4. **Metric-based monitoring**: Track proxy metrics (e.g., utterance count drop = potential INV-1.1 violation)

---

## References

- [Design by Contract (Eiffel)](https://en.wikipedia.org/wiki/Design_by_contract)
- [Property-Based Testing](https://hypothesis.readthedocs.io/)
- [Database Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- ADR-006: Testing Strategy and Quality Assurance

---

## Acceptance Criteria

- [ ] All 14 core invariants documented with assertions
- [ ] Invariant checking utilities implemented in `tests/invariants.py`
- [ ] Integration tests include invariant validation
- [ ] CI fails immediately when invariants violated
- [ ] Invariant violations produce actionable error messages
- [ ] README documents key invariants for developers

---

**Next Steps:**
1. Implement assertion utilities for each invariant
2. Add invariant checks to existing integration tests
3. Create golden dataset for invariant validation
4. Set up CI to enforce invariants on every commit
