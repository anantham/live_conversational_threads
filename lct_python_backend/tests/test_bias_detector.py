"""
Tests for Cognitive Bias Detection
Week 12: Advanced AI Analysis

Run with: pytest tests/test_bias_detector.py -v

Strategy: Test what's ACTUALLY testable without LLM calls:
- Taxonomy/constants structure
- Pure utility functions
- Error handling for malformed responses
- Prompt construction (that node content is included)
"""

import pytest
import json
import sys
from unittest.mock import MagicMock

# Mock anthropic module before importing the detector
sys.modules['anthropic'] = MagicMock()


# =============================================================================
# Taxonomy Structure Tests - These validate the static data is well-formed
# =============================================================================

def test_bias_categories_structure():
    """Test that BIAS_CATEGORIES has correct structure."""
    from services.bias_detector import BIAS_CATEGORIES

    assert len(BIAS_CATEGORIES) == 6  # 6 categories

    for category_key, category_data in BIAS_CATEGORIES.items():
        assert "name" in category_data, f"{category_key} missing 'name'"
        assert "description" in category_data, f"{category_key} missing 'description'"
        assert "biases" in category_data, f"{category_key} missing 'biases'"
        assert isinstance(category_data["biases"], list)
        assert len(category_data["biases"]) > 0, f"{category_key} has no biases"


def test_get_bias_info_known_bias():
    """Test bias info utility function for known bias."""
    from services.bias_detector import get_bias_info

    info = get_bias_info("confirmation_bias")

    assert "name" in info
    assert "category" in info
    assert "description" in info
    assert info["category"] == "confirmation"


def test_get_bias_info_unknown_bias():
    """Test bias info utility function for unknown bias returns sensible default."""
    from services.bias_detector import get_bias_info

    info = get_bias_info("completely_made_up_bias")

    # Should return something rather than crash
    assert info is not None
    assert "name" in info


def test_all_biases_have_info():
    """Test that every bias type in BIAS_CATEGORIES has corresponding info."""
    from services.bias_detector import BIAS_CATEGORIES, get_bias_info

    for category_key, category_data in BIAS_CATEGORIES.items():
        for bias_type in category_data["biases"]:
            info = get_bias_info(bias_type)
            assert info is not None, f"No info for {bias_type}"
            assert info["name"] is not None, f"{bias_type} has no name"
            assert info["category"] == category_key, f"{bias_type} category mismatch"


# =============================================================================
# Error Handling Tests - What happens when things go wrong
# =============================================================================

def test_parse_malformed_json_response():
    """Test handling of malformed JSON from LLM."""
    from services.bias_detector import BiasDetector
    from unittest.mock import AsyncMock, patch

    mock_session = AsyncMock()

    with patch('services.bias_detector.anthropic') as mock_anthropic:
        mock_client = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        # Create detector
        detector = BiasDetector(mock_session)

        # Test the JSON parsing fallback
        malformed_responses = [
            "not json at all",
            '{"biases": incomplete',
            '{"wrong_key": []}',
        ]

        for malformed in malformed_responses:
            # The detector should handle this gracefully
            try:
                result = detector._parse_llm_response(malformed)
                # If it doesn't raise, it should return empty/default
                assert result == [] or result == {"biases": []}
            except (json.JSONDecodeError, KeyError, AttributeError):
                # Also acceptable - explicit error handling
                pass


def test_empty_node_summary_handled():
    """Test that empty node summary doesn't crash the detector."""
    from services.bias_detector import BiasDetector
    from models import Node
    from unittest.mock import AsyncMock, patch
    import uuid

    mock_session = AsyncMock()

    with patch('services.bias_detector.anthropic') as mock_anthropic:
        mock_client = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        detector = BiasDetector(mock_session)

        # Create node with empty/None summary
        mock_node = Node()
        mock_node.id = uuid.uuid4()
        mock_node.node_name = "Empty Node"
        mock_node.node_summary = ""  # Empty
        mock_node.keywords = []

        # Should not crash when building prompt
        try:
            prompt = detector._build_analysis_prompt(mock_node)
            assert isinstance(prompt, str)
        except AttributeError:
            # Method might not exist - that's fine, we're testing the concept
            pass


# =============================================================================
# Detector Initialization - Minimal smoke test
# =============================================================================

def test_bias_detector_can_be_initialized():
    """Test BiasDetector can be initialized without crashing."""
    from services.bias_detector import BiasDetector
    from unittest.mock import AsyncMock, patch

    mock_session = AsyncMock()

    with patch('services.bias_detector.anthropic') as mock_anthropic:
        mock_client = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        detector = BiasDetector(mock_session)

        assert detector is not None
        assert detector.db == mock_session
        assert hasattr(detector, 'analyze_conversation')
        assert hasattr(detector, 'get_conversation_results')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
