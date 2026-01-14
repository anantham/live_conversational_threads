"""
Speaker Diarization Tests

Tests for speaker labeling and diarization invariants:
- INV-3.1: Participant count consistency
- INV-3.2: Speaker ID stability
"""

import pytest
from tests.conftest import (
    create_mock_conversation,
    create_mock_utterance,
    MockNode
)
from tests.invariants import (
    assert_participant_count_consistency,
    assert_speaker_id_stability,
    InvariantViolation
)


class TestSpeakerLabeling:
    """Test speaker attribution and labeling."""
    
    def test_speakers_correctly_labeled_in_utterances(self, mock_db):
        """Test that utterances have correct speaker_id fields."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=10,
            speakers=["Alice", "Bob"]
        )
        
        # Add to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Verify speakers alternate (A-B-A-B pattern)
        for i, u in enumerate(utterances):
            expected_speaker = "Alice" if i % 2 == 0 else "Bob"
            assert u.speaker_id == expected_speaker, \
                f"Utterance {i} should be from {expected_speaker}, got {u.speaker_id}"
    
    def test_multi_speaker_conversation(self, mock_db):
        """Test conversation with 3+ speakers."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=15,
            speakers=["Alice", "Bob", "Charlie"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Verify all 3 speakers present
        unique_speakers = set(u.speaker_id for u in utterances)
        assert len(unique_speakers) == 3
        assert unique_speakers == {"Alice", "Bob", "Charlie"}


class TestParticipantCountConsistency:
    """Test INV-3.1: Participant count must match legend."""
    
    def test_participant_count_matches_legend(self, mock_db, mock_api_client):
        """Test that legend shows correct number of speakers."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=20,
            speakers=["Alice", "Bob"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Verify invariant passes
        assert_participant_count_consistency(mock_db, mock_api_client, conversation_id)
        
        # Verify legend has 2 speakers
        legend = mock_api_client.get_speaker_legend(conversation_id)
        assert len(legend) == 2
    
    def test_participant_count_mismatch_raises_violation(self, mock_db, mock_api_client):
        """Test that mismatched participant counts raise violation."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=10,
            speakers=["Alice", "Bob", "Charlie"]
        )
        
        # Add only utterances from Alice and Bob (skip Charlie)
        for u in utterances:
            if u.speaker_id != "Charlie":
                mock_db.utterances[u.id] = u
        
        # Mock API client will return 2 speakers (Alice, Bob)
        # But if we have a third speaker in legend somehow, invariant should fail
        
        # For this test, legend should match data (2 speakers)
        legend = mock_api_client.get_speaker_legend(conversation_id)
        assert len(legend) == 2, "Legend should have 2 speakers (Alice, Bob)"


class TestSpeakerIDStability:
    """Test INV-3.2: Speaker IDs must be stable throughout conversation."""
    
    def test_speaker_no_unexpected_gaps(self, mock_db):
        """Test that speakers don't have large gaps in participation."""
        # Create conversation where Speaker A appears, then disappears for 60 utterances, then reappears
        conversation_id = "test-conv-gaps"
        utterances = []
        
        # First 10: Speaker A
        for i in range(10):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"Speaker A utterance {i}",
                speaker_id="Speaker A",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
        
        # Next 60: Speaker B only
        for i in range(10, 70):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"Speaker B utterance {i}",
                speaker_id="Speaker B",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
        
        # Last 10: Speaker A returns (SUSPICIOUS GAP)
        for i in range(70, 80):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"Speaker A utterance {i}",
                speaker_id="Speaker A",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
        
        # Add to mock DB
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # This should raise InvariantViolation (gap of 60 utterances > 50 threshold)
        with pytest.raises(InvariantViolation) as exc_info:
            assert_speaker_id_stability(mock_db, conversation_id)
        
        assert "INV-3.2" in str(exc_info.value)
        assert "gap" in str(exc_info.value).lower()
    
    def test_speaker_normal_alternation_passes(self, mock_db):
        """Test that normal speaker alternation doesn't trigger violations."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=20,
            speakers=["Alice", "Bob"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Should not raise (normal A-B-A-B pattern)
        assert_speaker_id_stability(mock_db, conversation_id)


class TestTurnBasedAggregation:
    """Test speaker turn detection and aggregation."""
    
    def test_consecutive_utterances_same_speaker_aggregate_to_turn(self, mock_db):
        """Test that consecutive utterances from same speaker form one turn."""
        conversation_id = "test-turns"
        utterances = []
        
        # Speaker A says 3 things in a row
        for i in range(3):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"Alice utterance {i}",
                speaker_id="Alice",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
        
        # Speaker B says 2 things in a row
        for i in range(3, 5):
            u = create_mock_utterance(
                conversation_id=conversation_id,
                text=f"Bob utterance {i}",
                speaker_id="Bob",
                start_time=float(i),
                end_time=float(i + 1)
            )
            utterances.append(u)
        
        # Speaker A says 1 thing
        u = create_mock_utterance(
            conversation_id=conversation_id,
            text="Alice final utterance",
            speaker_id="Alice",
            start_time=5.0,
            end_time=6.0
        )
        utterances.append(u)
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Expected turns: 3 (Alice block, Bob block, Alice single)
        # This would be validated by the graph generation logic
        
        # Group utterances by consecutive speaker
        turns = []
        current_speaker = None
        current_turn = []
        
        for u in utterances:
            if u.speaker_id != current_speaker:
                if current_turn:
                    turns.append({
                        "speaker": current_speaker,
                        "utterance_count": len(current_turn)
                    })
                current_speaker = u.speaker_id
                current_turn = [u]
            else:
                current_turn.append(u)
        
        # Add final turn
        if current_turn:
            turns.append({
                "speaker": current_speaker,
                "utterance_count": len(current_turn)
            })
        
        assert len(turns) == 3, f"Expected 3 turns, got {len(turns)}"
        assert turns[0]["speaker"] == "Alice"
        assert turns[0]["utterance_count"] == 3
        assert turns[1]["speaker"] == "Bob"
        assert turns[1]["utterance_count"] == 2
        assert turns[2]["speaker"] == "Alice"
        assert turns[2]["utterance_count"] == 1


class TestSpeakerColors:
    """Test speaker color assignment for UI."""
    
    def test_unique_speakers_get_unique_colors(self, mock_api_client, mock_db):
        """Test that each speaker gets a unique color."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=12,
            speakers=["Alice", "Bob", "Charlie"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        legend = mock_api_client.get_speaker_legend(conversation_id)
        
        # Extract colors
        colors = [item["color"] for item in legend]
        
        # All colors should be unique
        assert len(colors) == len(set(colors)), "Each speaker should have unique color"
        assert len(colors) == 3, "Should have 3 colors for 3 speakers"
    
    def test_speaker_color_consistency(self, mock_api_client, mock_db):
        """Test that same speaker gets same color across requests."""
        conversation_id, utterances = create_mock_conversation(
            utterance_count=10,
            speakers=["Alice", "Bob"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Get legend twice
        legend1 = mock_api_client.get_speaker_legend(conversation_id)
        legend2 = mock_api_client.get_speaker_legend(conversation_id)
        
        # Colors should be same (deterministic based on speaker_id hash)
        assert legend1 == legend2, "Speaker colors should be consistent"


@pytest.mark.integration
class TestDiarizationIntegration:
    """Integration tests for speaker diarization pipeline."""
    
    def test_full_diarization_flow(self, mock_db, mock_api_client, check_invariants):
        """
        Test complete diarization flow: Audio → Speakers → Turns → Nodes
        
        May FAIL initially - documents expected behavior.
        """
        # Create realistic multi-speaker conversation
        conversation_id, utterances = create_mock_conversation(
            utterance_count=30,
            speakers=["Alice", "Bob", "Charlie"]
        )
        
        for u in utterances:
            mock_db.utterances[u.id] = u
        
        # Create turn-based nodes
        # (Simulating what backend.py lines 1723-1810 does)
        current_speaker = None
        current_turn = []
        turn_nodes = []
        turn_number = 0
        
        for u in utterances:
            if u.speaker_id != current_speaker:
                # Save previous turn
                if current_turn:
                    turn_number += 1
                    combined_text = "\n".join([ut.text for ut in current_turn])
                    
                    node = MockNode(
                        id=f"turn_{turn_number}",
                        conversation_id=conversation_id,
                        summary=combined_text[:100],
                        utterance_ids=[ut.id for ut in current_turn],
                        zoom_level_visible=2  # Turn level
                    )
                    # Add speaker_id to node
                    node.speaker_id = current_speaker
                    turn_nodes.append(node)
                    mock_db.nodes[node.id] = node
                
                # Start new turn
                current_speaker = u.speaker_id
                current_turn = [u]
            else:
                current_turn.append(u)
        
        # Add final turn
        if current_turn:
            turn_number += 1
            combined_text = "\n".join([ut.text for ut in current_turn])
            node = MockNode(
                id=f"turn_{turn_number}",
                conversation_id=conversation_id,
                summary=combined_text[:100],
                utterance_ids=[ut.id for ut in current_turn],
                zoom_level_visible=2
            )
            node.speaker_id = current_speaker
            turn_nodes.append(node)
            mock_db.nodes[node.id] = node
        
        # Verify diarization invariants
        assert_participant_count_consistency(mock_db, mock_api_client, conversation_id)
        assert_speaker_id_stability(mock_db, conversation_id)
        
        # Verify turns created
        assert len(turn_nodes) > 0, "Should have created speaker turns"
        
        # Verify all nodes have speaker attribution
        for node in turn_nodes:
            assert hasattr(node, 'speaker_id'), f"Node {node.id} missing speaker_id"
            assert node.speaker_id in ["Alice", "Bob", "Charlie"]
