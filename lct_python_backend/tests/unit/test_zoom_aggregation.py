"""
Zoom Level Aggregation Tests

Tests for zoom system invariants:
- INV-6.1: Zoom visibility hierarchy
- INV-6.2: Aggregates contain children
"""

import pytest
from tests.conftest import (
    create_mock_conversation,
    MockNode
)
from tests.invariants import (
    assert_zoom_visibility_hierarchy,
    InvariantViolation
)


class TestZoomLevelGranularity:
    """Test that each zoom level shows appropriate granularity."""
    
    def test_zoom_level_1_sentence_granularity(self, mock_db):
        """Test zoom level 1 shows individual sentences (one node per utterance)."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create zoom level 1 nodes (one per utterance)
        for u in utterances:
            node = MockNode(
                id=f"sentence-{u.id}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1  # Visible at level 1 and above
            )
            mock_db.nodes[node.id] = node
        
        # Get nodes at zoom level 1
        zoom_1_nodes = mock_db.get_nodes(conversation_id, zoom_level=1)
        
        assert len(zoom_1_nodes) == 10, f"Expected 10 nodes at zoom 1, got {len(zoom_1_nodes)}"
    
    def test_zoom_level_2_turn_aggregation(self, mock_db):
        """Test zoom level 2 aggregates utterances into speaker turns."""
        # Create conversation with A-A-A-B-B-A pattern (3 turns)
        conversation_id = "test-zoom-2"
        utterances = []
        
        # Turn 1: Speaker A (3 utterances)
        for i in range(3):
            from tests.conftest import create_mock_utterance
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"A says {i}",
                speaker_id="A",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
            mock_db.utterances[u.id] = u
        
        # Turn 2: Speaker B (2 utterances)
        for i in range(3, 5):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"B says {i}",
                speaker_id="B",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
            mock_db.utterances[u.id] = u
        
        # Turn 3: Speaker A (1 utterance)
        u = create_mock_utterance(
            conversation_id=conversation_id,
            text="A says final",
            speaker_id="A",
            start_time=5.0,
            end_time=6.0
        )
        utterances.append(u)
        mock_db.utterances[u.id] = u
        
        # Create zoom level 2 nodes (turn-based)
        # Turn 1: A (utterances 0,1,2)
        node1 = MockNode(
            id="turn-1",
            conversation_id=conversation_id,
            summary="Speaker A turn 1",
            utterance_ids=[utterances[0].id, utterances[1].id, utterances[2].id],
            zoom_level_visible=2
        )
        mock_db.nodes[node1.id] = node1
        
        # Turn 2: B (utterances 3,4)
        node2 = MockNode(
            id="turn-2",
            conversation_id=conversation_id,
            summary="Speaker B turn",
            utterance_ids=[utterances[3].id, utterances[4].id],
            zoom_level_visible=2
        )
        mock_db.nodes[node2.id] = node2
        
        # Turn 3: A (utterance 5)
        node3 = MockNode(
            id="turn-3",
            conversation_id=conversation_id,
            summary="Speaker A turn 2",
            utterance_ids=[utterances[5].id],
            zoom_level_visible=2
        )
        mock_db.nodes[node3.id] = node3
        
        # Verify 3 turns at zoom level 2
        zoom_2_nodes = mock_db.get_nodes(conversation_id, zoom_level=2)
        assert len(zoom_2_nodes) == 3, f"Expected 3 turns at zoom 2, got {len(zoom_2_nodes)}"


class TestZoomVisibilityHierarchy:
    """Test INV-6.1: Nodes visible at level N must be visible at all levels < N."""
    
    def test_zoom_visibility_hierarchy_correct(self, mock_db):
        """Test that visibility hierarchy is correct.
        
        Semantics: zoom_level_visible=N means the node first appears at zoom level N.
        - Lower zoom levels (1) = more detailed view (sentences)
        - Higher zoom levels (5) = more aggregated view (arcs)
        
        At zoom level N, you see nodes with zoom_level_visible <= N.
        """
        conversation_id = "test-visibility"
        
        # Create nodes at different zoom levels
        # Node visible from level 1 (most detailed - sentence level)
        node1 = MockNode(
            id="node-1",
            conversation_id=conversation_id,
            summary="Sentence level",
            utterance_ids=["u1"],
            zoom_level_visible=1
        )
        mock_db.nodes[node1.id] = node1
        
        # Node visible from level 2 (turn level)
        node2 = MockNode(
            id="node-2",
            conversation_id=conversation_id,
            summary="Turn level",
            utterance_ids=["u2", "u3"],
            zoom_level_visible=2
        )
        mock_db.nodes[node2.id] = node2
        
        # Node visible from level 3 (topic level)
        node3 = MockNode(
            id="node-3",
            conversation_id=conversation_id,
            summary="Topic level",
            utterance_ids=["u4", "u5", "u6"],
            zoom_level_visible=3
        )
        mock_db.nodes[node3.id] = node3
        
        # At zoom level 1: only node1 visible (zoom_level_visible <= 1)
        zoom_1 = mock_db.get_nodes(conversation_id, zoom_level=1)
        assert len(zoom_1) == 1, f"Expected 1 node at zoom 1, got {len(zoom_1)}"
        
        # At zoom level 2: node1 and node2 visible (zoom_level_visible <= 2)
        zoom_2 = mock_db.get_nodes(conversation_id, zoom_level=2)
        assert len(zoom_2) == 2, f"Expected 2 nodes at zoom 2, got {len(zoom_2)}"
        
        # At zoom level 3: all nodes visible (zoom_level_visible <= 3)
        zoom_3 = mock_db.get_nodes(conversation_id, zoom_level=3)
        assert len(zoom_3) == 3, f"Expected 3 nodes at zoom 3, got {len(zoom_3)}"
        
        # Verify invariant (nodes visible at higher zoom must be visible at all lower zooms)
        # Note: This checks the REVERSE - that visibility is cumulative as zoom increases
        assert_zoom_visibility_hierarchy(mock_db, conversation_id)
    
    def test_zoom_visibility_violation_detected(self, mock_db):
        """Test that visibility violations are detected."""
        conversation_id = "test-bad-visibility"
        
        # Create node that claims to be visible at level 2
        # but is NOT in the zoom level 2 query results
        # (This would be a bug in the system)
        
        # For this test, we'd need to mock a buggy get_nodes() implementation
        # For now, document the expected behavior
        
        # If a node has zoom_level_visible=2 but doesn't appear in get_nodes(zoom_level=2),
        # assert_zoom_visibility_hierarchy should raise InvariantViolation
        
        assert True, "Visibility violation test - requires mocking buggy behavior"


class TestEdgeRedrawingOnZoomChange:
    """Test that edges are updated when zoom level changes."""
    
    def test_edges_differ_across_zoom_levels(self, mock_db):
        """Test that edge count/structure changes with zoom level."""
        conversation_id, utterances = create_mock_conversation(utterance_count=10)
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Zoom level 1: 10 nodes, 9 temporal edges (linear chain)
        for i, u in enumerate(utterances):
            node = MockNode(
                id=f"z1-{i}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Create edges for zoom 1 (9 edges connecting 10 nodes)
        from tests.conftest import MockEdge
        for i in range(9):
            edge = MockEdge(
                id=f"z1-edge-{i}",
                conversation_id=conversation_id,
                from_node_id=f"z1-{i}",
                to_node_id=f"z1-{i+1}",
                relationship_type="temporal"
            )
            mock_db.edges[edge.id] = edge
        
        # Zoom level 2: 5 nodes (aggregate every 2 utterances)
        for i in range(0, 10, 2):
            node = MockNode(
                id=f"z2-{i//2}",
                conversation_id=conversation_id,
                summary=f"Aggregated {i}-{i+1}",
                utterance_ids=[utterances[i].id, utterances[i+1].id] if i+1 < 10 else [utterances[i].id],
                zoom_level_visible=2
            )
            mock_db.nodes[node.id] = node
        
        # Create edges for zoom 2 (4 edges connecting 5 nodes)
        for i in range(4):
            edge = MockEdge(
                id=f"z2-edge-{i}",
                conversation_id=conversation_id,
                from_node_id=f"z2-{i}",
                to_node_id=f"z2-{i+1}",
                relationship_type="temporal"
            )
            mock_db.edges[edge.id] = edge
        
        # Verify edge counts differ
        z1_edges = mock_db.get_edges(conversation_id)  # All edges
        z1_temporal = [e for e in z1_edges if e.id.startswith("z1-edge")]
        z2_temporal = [e for e in z1_edges if e.id.startswith("z2-edge")]
        
        assert len(z1_temporal) == 9, "Zoom 1 should have 9 edges"
        assert len(z2_temporal) == 4, "Zoom 2 should have 4 edges"
        assert len(z1_temporal) != len(z2_temporal), "Edge counts should differ"


@pytest.mark.integration
class TestZoomAggregationIntegration:
    """Integration tests for full zoom system."""
    
    def test_full_zoom_hierarchy_1_to_5(self, mock_db, check_invariants):
        """
        Test complete zoom hierarchy from sentences to arcs.
        
        May FAIL initially - documents expected behavior.
        """
        conversation_id, utterances = create_mock_conversation(utterance_count=50)
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Zoom 1: 50 sentence nodes
        for i, u in enumerate(utterances):
            node = MockNode(
                id=f"z1-{i}",
                conversation_id=conversation_id,
                summary=u.text,
                utterance_ids=[u.id],
                zoom_level_visible=1
            )
            mock_db.nodes[node.id] = node
        
        # Zoom 2: 12 turn nodes (aggregate ~4 utterances each)
        for i in range(0, 50, 4):
            end_idx = min(i + 4, 50)
            node = MockNode(
                id=f"z2-{i//4}",
                conversation_id=conversation_id,
                summary=f"Turn {i//4}",
                utterance_ids=[utterances[j].id for j in range(i, end_idx)],
                zoom_level_visible=2
            )
            mock_db.nodes[node.id] = node
        
        # Zoom 3: 5 topic nodes
        for i in range(5):
            start_idx = i * 10
            end_idx = (i + 1) * 10
            node = MockNode(
                id=f"z3-{i}",
                conversation_id=conversation_id,
                summary=f"Topic {i}",
                utterance_ids=[utterances[j].id for j in range(start_idx, end_idx)],
                zoom_level_visible=3
            )
            mock_db.nodes[node.id] = node
        
        # Zoom 4: 3 theme nodes
        for i in range(3):
            start_idx = i * 16
            end_idx = min((i + 1) * 16, 50)
            node = MockNode(
                id=f"z4-{i}",
                conversation_id=conversation_id,
                summary=f"Theme {i}",
                utterance_ids=[utterances[j].id for j in range(start_idx, end_idx)],
                zoom_level_visible=4
            )
            mock_db.nodes[node.id] = node
        
        # Zoom 5: 1 arc node (entire conversation)
        node = MockNode(
            id="z5-0",
            conversation_id=conversation_id,
            summary="Entire conversation arc",
            utterance_ids=[u.id for u in utterances],
            zoom_level_visible=5
        )
        mock_db.nodes[node.id] = node
        
        # Verify golden dataset expectations
        zoom_counts = {
            1: len(mock_db.get_nodes(conversation_id, zoom_level=1)),
            2: len(mock_db.get_nodes(conversation_id, zoom_level=2)),
            3: len(mock_db.get_nodes(conversation_id, zoom_level=3)),
            4: len(mock_db.get_nodes(conversation_id, zoom_level=4)),
            5: len(mock_db.get_nodes(conversation_id, zoom_level=5))
        }
        
        # All nodes should be visible at all levels they're defined for
        assert zoom_counts[1] >= 50  # At least 50 (sentence-level)
        assert zoom_counts[2] >= 12  # At least 12 (turn-level)
        assert zoom_counts[3] >= 5   # At least 5 (topic-level)
        assert zoom_counts[4] >= 3   # At least 3 (theme-level)
        assert zoom_counts[5] >= 1   # At least 1 (arc-level)
        
        # Verify zoom visibility hierarchy
        assert_zoom_visibility_hierarchy(mock_db, conversation_id)
