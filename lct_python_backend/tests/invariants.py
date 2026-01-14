"""
System Invariant Assertions for Live Conversational Threads

This module provides reusable assertion utilities for validating system invariants
as defined in ADR-007. These assertions should be used in integration and E2E tests
to ensure data integrity and correctness.

Usage:
    from tests.invariants import check_data_completeness_invariants

    def test_full_pipeline():
        conversation_id = run_audio_pipeline()
        check_data_completeness_invariants(conversation_id)
"""

from typing import List, Set
from datetime import datetime, timedelta
import numpy as np


class InvariantViolation(Exception):
    """Raised when a system invariant is violated."""
    
    def __init__(self, invariant_id: str, message: str, context: dict = None):
        self.invariant_id = invariant_id
        self.message = message
        self.context = context or {}
        super().__init__(f"[{invariant_id}] {message}\nContext: {context}")


# ============================================================================
# Data Completeness Invariants
# ============================================================================

def assert_utterance_node_completeness(db, conversation_id: str):
    """
    INV-1.1: Every utterance must map to at least one node at zoom level 1.
    
    At the highest resolution (sentence-level), every utterance in the transcript
    must have a corresponding node. If utterances are lost here, they're lost forever.
    """
    utterances = db.get_utterances(conversation_id)
    zoom_1_nodes = db.get_nodes(conversation_id, zoom_level=1)
    
    utterance_ids = {u.id for u in utterances}
    nodes_utterance_ids = set()
    
    for node in zoom_1_nodes:
        if hasattr(node, 'utterance_ids') and node.utterance_ids:
            nodes_utterance_ids.update(node.utterance_ids)
    
    missing_utterances = utterance_ids - nodes_utterance_ids
    
    if missing_utterances:
        raise InvariantViolation(
            "INV-1.1",
            f"{len(missing_utterances)} utterances have no corresponding node at zoom level 1",
            {
                "conversation_id": conversation_id,
                "total_utterances": len(utterances),
                "missing_utterance_ids": list(missing_utterances)[:10]  # First 10
            }
        )


def assert_timeline_completeness(db, api_client, conversation_id: str):
    """
    INV-1.2: Timeline view must contain all utterances in temporal order.
    
    Timeline is the source of truth for "what was actually said."
    """
    utterances = db.get_utterances(conversation_id, order_by="start_time")
    timeline_data = api_client.get_timeline_view(conversation_id)
    
    if len(timeline_data) != len(utterances):
        raise InvariantViolation(
            "INV-1.2",
            f"Timeline has {len(timeline_data)} items but {len(utterances)} utterances",
            {
                "conversation_id": conversation_id,
                "expected_count": len(utterances),
                "actual_count": len(timeline_data)
            }
        )
    
    # Verify ordering
    for i, (timeline_item, utterance) in enumerate(zip(timeline_data, utterances)):
        if timeline_item.get("utterance_id") != utterance.id:
            raise InvariantViolation(
                "INV-1.2",
                f"Timeline order mismatch at position {i}",
                {
                    "position": i,
                    "expected_utterance_id": utterance.id,
                    "actual_utterance_id": timeline_item.get("utterance_id")
                }
            )


def assert_lossless_aggregation(db, conversation_id: str, zoom_from: int, zoom_to: int):
    """
    INV-1.3: Aggregation must preserve all utterance IDs (no deletion, only grouping).
    
    When aggregating nodes from zoom level N to N+1, all utterance IDs must be
    preserved. We're just grouping, not discarding.
    
    Note: We filter by EXACT zoom level (zoom_level_visible == N) not cumulative,
    because we want to compare the specific nodes at each aggregation level.
    
    If no nodes exist at the destination zoom level, we skip the check - that level
    may not have been generated yet.
    """
    # Get all nodes and filter by exact zoom level
    all_nodes = [n for n in db.nodes.values() if n.conversation_id == conversation_id]
    
    nodes_from = [n for n in all_nodes if getattr(n, 'zoom_level_visible', 1) == zoom_from]
    nodes_to = [n for n in all_nodes if getattr(n, 'zoom_level_visible', 1) == zoom_to]
    
    # Skip check if source or destination has no nodes
    if not nodes_from or not nodes_to:
        return  # Can't compare if one level doesn't exist yet
    
    utterances_from = set()
    for node in nodes_from:
        if hasattr(node, 'utterance_ids') and node.utterance_ids:
            utterances_from.update(node.utterance_ids)
    
    utterances_to = set()
    for node in nodes_to:
        if hasattr(node, 'utterance_ids') and node.utterance_ids:
            utterances_to.update(node.utterance_ids)
    
    lost_utterances = utterances_from - utterances_to
    
    if lost_utterances:
        raise InvariantViolation(
            "INV-1.3",
            f"Aggregation from zoom {zoom_from} to {zoom_to} lost {len(lost_utterances)} utterances",
            {
                "conversation_id": conversation_id,
                "zoom_from": zoom_from,
                "zoom_to": zoom_to,
                "lost_utterance_ids": list(lost_utterances)[:10]
            }
        )


# ============================================================================
# Audio Pipeline Invariants
# ============================================================================

def assert_audio_not_silent(audio_buffer: np.ndarray, duration_seconds: float, threshold: float = 0.01):
    """
    INV-2.2: Audio should have non-trivial amplitude if recording for >5 seconds.
    
    Prevent "silent recordings" where user thinks they're recording but mic is muted/broken.
    """
    if duration_seconds > 5:
        rms_amplitude = np.sqrt(np.mean(audio_buffer ** 2))
        
        if rms_amplitude < threshold:
            raise InvariantViolation(
                "INV-2.2",
                f"Audio amplitude too low ({rms_amplitude:.4f}), likely silent/muted",
                {
                    "duration_seconds": duration_seconds,
                    "rms_amplitude": rms_amplitude,
                    "threshold": threshold
                }
            )


def assert_transcription_latency(db, conversation_id: str, max_p95_latency_seconds: float = 10.0):
    """
    INV-2.3: Transcript must appear within 10 seconds (P95 latency).
    
    User expects near-real-time feedback that transcription is working.
    """
    events = db.get_instrumentation_events(
        conversation_id,
        event_type="transcription"
    )
    
    if not events:
        # No transcription events yet - might be too early to check
        return
    
    latencies = []
    for event in events:
        if "transcript_received_at" in event and "audio_sent_at" in event:
            latency = event["transcript_received_at"] - event["audio_sent_at"]
            latencies.append(latency)
    
    if latencies:
        p95_latency = np.percentile(latencies, 95)
        
        if p95_latency > max_p95_latency_seconds:
            raise InvariantViolation(
                "INV-2.3",
                f"P95 transcription latency {p95_latency:.2f}s exceeds threshold",
                {
                    "conversation_id": conversation_id,
                    "p95_latency": p95_latency,
                    "threshold": max_p95_latency_seconds,
                    "sample_count": len(latencies)
                }
            )


# ============================================================================
# Speaker Diarization Invariants
# ============================================================================

def assert_participant_count_consistency(db, api_client, conversation_id: str):
    """
    INV-3.1: Number of unique speakers in legend must equal unique speakers in data.
    """
    utterances = db.get_utterances(conversation_id)
    unique_speakers = {u.speaker_id for u in utterances if hasattr(u, 'speaker_id')}
    
    legend_speakers = api_client.get_speaker_legend(conversation_id)
    
    if len(legend_speakers) != len(unique_speakers):
        raise InvariantViolation(
            "INV-3.1",
            f"Legend shows {len(legend_speakers)} speakers but data has {len(unique_speakers)}",
            {
                "conversation_id": conversation_id,
                "legend_speakers": [s.get("speaker_id") for s in legend_speakers],
                "data_speakers": list(unique_speakers)
            }
        )


def assert_speaker_id_stability(db, conversation_id: str):
    """
    INV-3.2: Speaker IDs must be stable throughout a conversation.
    
    Speaker IDs should not change mid-conversation (no ID swaps or resurrections).
    A gap of more than 50 utterances where a speaker is absent and then reappears
    is suspicious and may indicate diarization errors.
    """
    utterances = db.get_utterances(conversation_id, order_by="start_time")
    
    if not utterances:
        return
    
    # Group utterance positions by speaker
    speaker_positions = {}
    for i, utterance in enumerate(utterances):
        if not hasattr(utterance, 'speaker_id'):
            continue
            
        speaker = utterance.speaker_id
        if speaker not in speaker_positions:
            speaker_positions[speaker] = []
        speaker_positions[speaker].append(i)
    
    # Check for gaps larger than 50 utterances for each speaker
    for speaker, positions in speaker_positions.items():
        if len(positions) < 2:
            continue  # Need at least 2 appearances to have a gap
            
        for i in range(len(positions) - 1):
            gap = positions[i + 1] - positions[i]
            if gap > 50:
                raise InvariantViolation(
                    "INV-3.2",
                    f"Speaker {speaker} has suspicious gap of {gap} utterances",
                    {
                        "conversation_id": conversation_id,
                        "speaker_id": speaker,
                        "gap_size": gap,
                        "position_before": positions[i],
                        "position_after": positions[i + 1]
                    }
                )


# ============================================================================
# Graph Structure Invariants
# ============================================================================

def assert_no_dangling_edges(db, conversation_id: str):
    """
    INV-4.1: Every edge must connect two existing nodes (no dangling edges).
    """
    nodes = db.get_nodes(conversation_id)
    node_ids = {n.id for n in nodes}
    
    edges = db.get_edges(conversation_id)
    
    for edge in edges:
        if edge.from_node_id not in node_ids:
            raise InvariantViolation(
                "INV-4.1",
                f"Edge {edge.id} has invalid from_node_id: {edge.from_node_id}",
                {
                    "conversation_id": conversation_id,
                    "edge_id": edge.id,
                    "invalid_node_id": edge.from_node_id
                }
            )
        
        if edge.to_node_id not in node_ids:
            raise InvariantViolation(
                "INV-4.1",
                f"Edge {edge.id} has invalid to_node_id: {edge.to_node_id}",
                {
                    "conversation_id": conversation_id,
                    "edge_id": edge.id,
                    "invalid_node_id": edge.to_node_id
                }
            )


def assert_temporal_edge_ordering(db, conversation_id: str):
    """
    INV-4.2: Temporal edges must respect chronological order (no time-traveling).
    """
    edges = db.get_edges(conversation_id, relationship_type="temporal")
    nodes = {n.id: n for n in db.get_nodes(conversation_id)}
    
    for edge in edges:
        from_node = nodes.get(edge.from_node_id)
        to_node = nodes.get(edge.to_node_id)
        
        if not from_node or not to_node:
            continue  # Will be caught by INV-4.1
        
        # Get max end time of from_node utterances
        if hasattr(from_node, 'utterance_ids') and from_node.utterance_ids:
            from_utterances = [
                db.get_utterance(uid) for uid in from_node.utterance_ids
            ]
            from_max_time = max(
                u.end_time for u in from_utterances
                if hasattr(u, 'end_time') and u.end_time is not None
            )
        else:
            continue
        
        # Get min start time of to_node utterances
        if hasattr(to_node, 'utterance_ids') and to_node.utterance_ids:
            to_utterances = [
                db.get_utterance(uid) for uid in to_node.utterance_ids
            ]
            to_min_time = min(
                u.start_time for u in to_utterances
                if hasattr(u, 'start_time') and u.start_time is not None
            )
        else:
            continue
        
        if from_max_time > to_min_time:
            raise InvariantViolation(
                "INV-4.2",
                f"Temporal edge {edge.id} violates chronological order",
                {
                    "conversation_id": conversation_id,
                    "edge_id": edge.id,
                    "from_node_latest_time": from_max_time,
                    "to_node_earliest_time": to_min_time
                }
            )


# ============================================================================
# Instrumentation Invariants
# ============================================================================

def assert_all_api_calls_logged(db, conversation_id: str, expected_call_count: int = None):
    """
    INV-5.1: Every LLM API call must be logged with cost and latency.
    """
    api_logs = db.get_api_calls_log(conversation_id)
    
    if expected_call_count is not None and len(api_logs) != expected_call_count:
        raise InvariantViolation(
            "INV-5.1",
            f"Expected {expected_call_count} API calls, found {len(api_logs)}",
            {
                "conversation_id": conversation_id,
                "expected": expected_call_count,
                "actual": len(api_logs)
            }
        )
    
    for log in api_logs:
        if log.cost_usd is None:
            raise InvariantViolation(
                "INV-5.1",
                f"API call {log.id} missing cost",
                {"conversation_id": conversation_id, "log_id": log.id}
            )
        
        if log.latency_ms is None:
            raise InvariantViolation(
                "INV-5.1",
                f"API call {log.id} missing latency",
                {"conversation_id": conversation_id, "log_id": log.id}
            )
        
        if log.total_tokens is None:
            raise InvariantViolation(
                "INV-5.1",
                f"API call {log.id} missing token count",
                {"conversation_id": conversation_id, "log_id": log.id}
            )


# ============================================================================
# Zoom System Invariants
# ============================================================================

def assert_zoom_visibility_hierarchy(db, conversation_id: str):
    """
    INV-6.1: Nodes visible at zoom level N must be visible at all levels < N.
    
    Lower zoom numbers = more detail. If something is visible at level 3,
    it must be visible at level 1 and 2.
    """
    all_nodes = db.get_nodes(conversation_id)
    
    for node in all_nodes:
        if not hasattr(node, 'zoom_level_visible'):
            continue
            
        min_visible = node.zoom_level_visible
        
        # Check visibility at each zoom level
        for zoom in range(1, 6):
            visible_nodes = db.get_nodes(conversation_id, zoom_level=zoom)
            visible_node_ids = {n.id for n in visible_nodes}
            
            if zoom >= min_visible:
                # Node should be visible
                if node.id not in visible_node_ids:
                    raise InvariantViolation(
                        "INV-6.1",
                        f"Node {node.id} should be visible at zoom {zoom} (min={min_visible})",
                        {
                            "conversation_id": conversation_id,
                            "node_id": node.id,
                            "zoom_level": zoom,
                            "min_visible_level": min_visible
                        }
                    )


# ============================================================================
# Convenience Functions (Run All Checks)
# ============================================================================

def check_data_completeness_invariants(db, api_client, conversation_id: str):
    """Run all data completeness invariant checks."""
    assert_utterance_node_completeness(db, conversation_id)
    assert_timeline_completeness(db, api_client, conversation_id)
    
    # Check aggregation for zoom levels 1→2, 2→3, etc.
    for zoom_from, zoom_to in [(1, 2), (2, 3), (3, 4), (4, 5)]:
        assert_lossless_aggregation(db, conversation_id, zoom_from, zoom_to)


def check_speaker_diarization_invariants(db, api_client, conversation_id: str):
    """Run all speaker diarization invariant checks."""
    assert_participant_count_consistency(db, api_client, conversation_id)
    assert_speaker_id_stability(db, conversation_id)


def check_graph_structure_invariants(db, conversation_id: str):
    """Run all graph structure invariant checks."""
    assert_no_dangling_edges(db, conversation_id)
    assert_temporal_edge_ordering(db, conversation_id)


def check_instrumentation_invariants(db, conversation_id: str):
    """Run all instrumentation invariant checks."""
    assert_all_api_calls_logged(db, conversation_id)


def check_zoom_system_invariants(db, conversation_id: str):
    """Run all zoom system invariant checks."""
    assert_zoom_visibility_hierarchy(db, conversation_id)


def check_all_invariants(db, api_client, conversation_id: str):
    """Run ALL system invariant checks."""
    check_data_completeness_invariants(db, api_client, conversation_id)
    check_speaker_diarization_invariants(db, api_client, conversation_id)
    check_graph_structure_invariants(db, conversation_id)
    check_instrumentation_invariants(db, conversation_id)
    check_zoom_system_invariants(db, conversation_id)
