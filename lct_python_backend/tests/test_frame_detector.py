"""
Tests for Implicit Frame Detection
Week 13: Advanced AI Analysis

Run with: pytest tests/test_frame_detector.py -v

Strategy: Test what's ACTUALLY testable without LLM calls:
- Taxonomy/constants structure
- Pure utility functions
- Error handling
"""

import pytest
import sys
from unittest.mock import MagicMock

# Mock anthropic module before importing the detector
sys.modules['anthropic'] = MagicMock()


# =============================================================================
# Taxonomy Structure Tests
# =============================================================================

def test_frame_categories_structure():
    """Test that FRAME_CATEGORIES has correct structure."""
    from services.frame_detector import FRAME_CATEGORIES

    assert len(FRAME_CATEGORIES) == 6  # 6 categories

    for category_key, category_data in FRAME_CATEGORIES.items():
        assert "name" in category_data, f"{category_key} missing 'name'"
        assert "description" in category_data, f"{category_key} missing 'description'"
        assert "frames" in category_data, f"{category_key} missing 'frames'"
        assert isinstance(category_data["frames"], list)
        assert len(category_data["frames"]) > 0, f"{category_key} has no frames"


def test_get_frame_info_known_frame():
    """Test frame info utility function for known frame."""
    from services.frame_detector import get_frame_info

    info = get_frame_info("market_fundamentalism")

    assert "name" in info
    assert "category" in info
    assert "description" in info
    assert info["category"] == "economic"


def test_get_frame_info_unknown_frame():
    """Test frame info utility function for unknown frame."""
    from services.frame_detector import get_frame_info

    info = get_frame_info("completely_made_up_frame")

    # Should return something rather than crash
    assert info is not None
    assert "name" in info


def test_all_frames_have_info():
    """Test that every frame type in FRAME_CATEGORIES has corresponding info."""
    from services.frame_detector import FRAME_CATEGORIES, get_frame_info

    for category_key, category_data in FRAME_CATEGORIES.items():
        for frame_type in category_data["frames"]:
            info = get_frame_info(frame_type)
            assert info is not None, f"No info for {frame_type}"
            assert info["name"] is not None, f"{frame_type} has no name"
            assert info["category"] == category_key, f"{frame_type} category mismatch"


def test_no_duplicate_frame_types():
    """Test that no frame type appears in multiple categories."""
    from services.frame_detector import FRAME_CATEGORIES

    all_frames = []
    for category_data in FRAME_CATEGORIES.values():
        all_frames.extend(category_data["frames"])

    assert len(all_frames) == len(set(all_frames)), "Duplicate frame types found"


# =============================================================================
# Detector Initialization
# =============================================================================

def test_frame_detector_can_be_initialized():
    """Test FrameDetector can be initialized without crashing."""
    from services.frame_detector import FrameDetector
    from unittest.mock import AsyncMock, patch

    mock_session = AsyncMock()

    with patch('services.frame_detector.anthropic') as mock_anthropic:
        mock_client = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        detector = FrameDetector(mock_session)

        assert detector is not None
        assert detector.db == mock_session
        assert hasattr(detector, 'analyze_conversation')
        assert hasattr(detector, 'get_conversation_results')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
