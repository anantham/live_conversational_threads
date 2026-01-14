"""
Integration Tests for All Analysis Features
Week 14: Integration, Polish & Deployment

Run with: pytest tests/test_integration_all_features.py -v

Strategy: Test structural contracts, not LLM behavior.
These tests validate that the system's pieces fit together correctly.
"""

import pytest
import sys
from unittest.mock import MagicMock

# Mock anthropic module before importing
sys.modules['anthropic'] = MagicMock()


# =============================================================================
# Taxonomy Structure Tests - Validate static definitions are consistent
# =============================================================================

def test_taxonomy_structures_exist():
    """Test that all taxonomy structures are defined and non-empty."""
    from services.bias_detector import BIAS_CATEGORIES
    from services.frame_detector import FRAME_CATEGORIES

    # Bias taxonomy
    assert len(BIAS_CATEGORIES) == 6, "Should have 6 bias categories"
    for category, info in BIAS_CATEGORIES.items():
        assert "name" in info
        assert "description" in info
        assert "biases" in info
        assert len(info["biases"]) > 0

    # Frame taxonomy
    assert len(FRAME_CATEGORIES) == 6, "Should have 6 frame categories"
    for category, info in FRAME_CATEGORIES.items():
        assert "name" in info
        assert "description" in info
        assert "frames" in info
        assert len(info["frames"]) > 0


def test_no_duplicate_identifiers():
    """Test that bias and frame types have no duplicates within their taxonomies."""
    from services.bias_detector import BIAS_CATEGORIES
    from services.frame_detector import FRAME_CATEGORIES

    # Check biases
    all_biases = []
    for category in BIAS_CATEGORIES.values():
        all_biases.extend(category["biases"])
    assert len(all_biases) == len(set(all_biases)), "Duplicate bias types found"

    # Check frames
    all_frames = []
    for category in FRAME_CATEGORIES.values():
        all_frames.extend(category["frames"])
    assert len(all_frames) == len(set(all_frames)), "Duplicate frame types found"


# =============================================================================
# Model Structure Tests - Validate database models match API expectations
# =============================================================================

def test_models_have_required_fields():
    """Test that database models have required fields for API."""
    from models import SimulacraAnalysis, BiasAnalysis, FrameAnalysis

    # Common fields all analysis models should have
    common_fields = ['id', 'node_id', 'conversation_id', 'confidence', 'analyzed_at']

    for model in [SimulacraAnalysis, BiasAnalysis, FrameAnalysis]:
        for field in common_fields:
            assert hasattr(model, field), f"{model.__name__} missing {field}"


# =============================================================================
# API Contract Tests - Validate async interface contracts
# =============================================================================

def test_detectors_use_async_methods():
    """Verify all detectors use async/await properly for concurrent analysis."""
    from services.simulacra_detector import SimulacraDetector
    from services.bias_detector import BiasDetector
    from services.frame_detector import FrameDetector
    import inspect

    for detector_class in [SimulacraDetector, BiasDetector, FrameDetector]:
        # Main analysis methods must be async
        assert inspect.iscoroutinefunction(detector_class.analyze_conversation), \
            f"{detector_class.__name__}.analyze_conversation must be async"
        assert inspect.iscoroutinefunction(detector_class.get_conversation_results), \
            f"{detector_class.__name__}.get_conversation_results must be async"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
