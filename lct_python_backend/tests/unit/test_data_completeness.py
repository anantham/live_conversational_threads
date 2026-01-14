"""
Data Completeness Tests

Tests for system invariants INV-1.1, INV-1.2, INV-1.3:
- Every utterance becomes a node at zoom level 1
- Timeline view contains all utterances
- No utterances lost in zoom aggregation
"""

import pytest
from tests.conftest import (
    create_mock_conversation,
    MockNode,
    MockEdge
)
from tests.invariants import (
    assert_utterance_node_completeness,
    assert_timeline_completeness,
    assert_lossless_aggregation,
    InvariantViolation
)


class TestUtteranceNodeCompleteness:
    """Test INV-1.1: Every utterance must become a node at zoom level 1."""
    
    def test_all_utterances_have_nodes(self, mock_db, check_invariants):
        """Test that every utterance maps to at least one node."""
        # Create test conversation with 10 utterances
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        # Add utterances to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create nodes for all utterances (zoom level 1)
        for u in utterances:
            node = MockNode(
                id=f"node-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Should pass - all utterances have nodes
        check_invariants(conversation_id)
    
    def test_missing_node_raises_violation(self, mock_db):
        """Test that missing node for an utterance raises violation."""
        conversation_id, utterances = create_mock_conversation(utterance_count=5)
        
        # Add utterances to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create nodes for only SOME utterances (missing one)
        for u in utterances[:-1]:  # Skip last utterance
            node = MockNode(
                id=f"node-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Should raise InvariantViolation
        with pytest.raises(InvariantViolation) as exc_info:
            assert_utterance_node_completeness(mock_db, conversation_id)
        
        assert "INV-1.1" in str(exc_info.value)
        assert "1 utterances have no corresponding node" in str(exc_info.value)


class TestTimelineCompleteness:
    """Test INV-1.2: Timeline view must contain all utterances."""
    
    def test_timeline_contains_all_utterances(self, mock_db, mock_api_client):
        """Test that timeline view has all utterances in order."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        # Add utterances to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Should pass - mock API client returns all utterances
        assert_timeline_completeness(mock_db, mock_api_client, conversation_id)
    
    def test_timeline_count_mismatch_raises_violation(self, mock_db, mock_api_client):
        """Test that timeline with wrong count raises violation."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        # Add only 5 utterances to mock DB (but API expects 10)
        for u in utterances[:5]:
            mock_db.utterances[u.id] = u
        
        # Timeline will have only 5, but we expected 10
        # (This would normally not happen, but tests the invariant)
        # Actually, our mock returns what's in DB, so this test needs adjustment
        # Let's test by mocking the API response
        
        class BadAPIClient:
            def get_timeline_view(self, conv_id):
                return []  # Return empty timeline
        
        bad_client = BadAPIClient()
        
        with pytest.raises(InvariantViolation) as exc_info:
            assert_timeline_completeness(mock_db, bad_client, conversation_id)
        
        assert "INV-1.2" in str(exc_info.value)


class TestLosslessAggregation:
    """Test INV-1.3: Zoom aggregation preserves all utterances."""
    
    def test_aggregation_preserves_utterances(self, mock_db):
        """Test that aggregating zoom 1→2 preserves all utterance IDs."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        # Add utterances to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create zoom level 1 nodes (one per utterance)
        zoom_1_nodes = []
        for u in utterances:
            node = MockNode(
                id=f"zoom1-node-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            zoom_1_nodes.append(node)
            mock_db.nodes[node.id] = node
        
        # Create zoom level 2 nodes (aggregate 2 utterances each)
        for i in range(0, len(utterances), 2):
            node = MockNode(
                id=f"zoom2-node-{i}",
                conversation_id=conversation_id,
                summary=f"Aggregated {i}-{i+1}",
                utterance_ids=[utterances[i].id, utterances[i+1].id] if i+1 < len(utterances) else [utterances[i].id],
                zoom_level_visible=2
            )
            mock_db.nodes[node.id] = node
        
        # Should pass - all utterances preserved in aggregation
        assert_lossless_aggregation(mock_db, conversation_id, zoom_from=1, zoom_to=2)
    
    def test_aggregation_with_lost_utterance_raises_violation(self, mock_db):
        """Test that losing an utterance during aggregation raises violation."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create zoom level 1 nodes
        for u in utterances:
            node = MockNode(
                id=f"zoom1-node-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Create zoom level 2 nodes but SKIP last 2 utterances (simulate data loss)
        # Only create nodes for utterances 0-7, skipping 8 and 9
        for i in range(0, len(utterances) - 2, 2):  # range(0, 8, 2) = [0, 2, 4, 6]
            node = MockNode(
                id=f"zoom2-node-{i}",
                conversation_id=conversation_id,
                summary=f"Aggregated {i}-{i+1}",
                utterance_ids=[utterances[i].id, utterances[i+1].id],
                zoom_level_visible=2
            )
            mock_db.nodes[node.id] = node
        
        # Should raise InvariantViolation (utterances 8 and 9 lost)
        with pytest.raises(InvariantViolation) as exc_info:
            assert_lossless_aggregation(mock_db, conversation_id, zoom_from=1, zoom_to=2)
        
        assert "INV-1.3" in str(exc_info.value)
        assert "lost" in str(exc_info.value).lower()


@pytest.mark.integration
class TestFullDataCompletenessFlow:
    """Integration tests for full data completeness pipeline."""
    
    def test_import_to_visualization_preserves_all_data(self, mock_db, mock_api_client, check_invariants):
        """
        End-to-end test: Import conversation → Generate nodes → Validate completeness.
        
        NOTE: This test will likely FAIL initially as it depends on full pipeline
        implementation. That's expected - it documents the desired behavior.
        """
        # Create a realistic conversation
        conversation_id, utterances = create_mock_conversation(
            utterance_count=20,
            speakers=["Alice", "Bob"]
        )
        
        # Simulate import
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Simulate graph generation at all zoom levels
        # Zoom 1: One node per utterance
        for u in utterances:
            node = MockNode(
                id=f"z1-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Zoom 2: Aggregate every 3 utterances
        for i in range(0, len(utterances), 3):
            utterance_ids = [u.id for u in utterances[i:i+3]]
            node = MockNode(
                id=f"z2-{i}",
                conversation_id=conversation_id,
                summary=f"Topic {i//3}",
                utterance_ids=utterance_ids,
                zoom_level_visible=2
            )
            mock_db.nodes[node.id] = node
        
        # Check all data completeness invariants
        check_invariants(conversation_id)
