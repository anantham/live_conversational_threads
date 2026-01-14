"""
Tests for IsOughtDetector service - Naturalistic Fallacy Detection

Run with: pytest tests/test_is_ought_detector.py -v

Strategy: Test what's ACTUALLY testable without LLM calls:
- Temporal proximity calculation (pure function)
- Filtering logic
- Initialization
"""

import pytest
import os
import sys
from unittest.mock import MagicMock, AsyncMock, patch

# Mock before import
sys.modules['anthropic'] = MagicMock()

# Set fake API keys for tests
os.environ.setdefault('ANTHROPIC_API_KEY', 'test-key-for-testing')
os.environ.setdefault('OPENAI_API_KEY', 'test-key-for-testing')


@pytest.fixture
def mock_db_session():
    """Mock database session for testing."""
    from sqlalchemy.ext.asyncio import AsyncSession
    session = AsyncMock(spec=AsyncSession)
    return session


@pytest.fixture
def is_ought_detector(mock_db_session):
    """Create IsOughtDetector instance with mocked dependencies."""
    from services.is_ought_detector import IsOughtDetector
    detector = IsOughtDetector(mock_db_session)
    return detector


# =============================================================================
# Pure Function Tests - Temporal Proximity Calculation
# =============================================================================

def test_temporal_proximity_adjacent_claims(is_ought_detector):
    """Test that adjacent claims have high proximity."""
    factual_claim = {"claim_text": "The economy grew 3%", "sequence": 0}
    normative_claim = {"claim_text": "We should continue this policy", "sequence": 1}

    proximity = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim)

    # Adjacent claims should have high proximity (close to 1.0)
    assert proximity > 0.8


def test_temporal_proximity_distant_claims(is_ought_detector):
    """Test that distant claims have low proximity."""
    factual_claim = {"claim_text": "The economy grew 3%", "sequence": 0}
    normative_claim = {"claim_text": "We should continue this policy", "sequence": 50}

    proximity = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim)

    # Distant claims should have low proximity
    assert proximity < 0.5


def test_temporal_proximity_same_sequence(is_ought_detector):
    """Test that same-sequence claims have maximum proximity."""
    factual_claim = {"claim_text": "Natural is good", "sequence": 5}
    normative_claim = {"claim_text": "We should do natural things", "sequence": 5}

    proximity = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim)

    # Same sequence = same utterance = maximum proximity
    assert proximity == 1.0


def test_temporal_proximity_missing_sequence(is_ought_detector):
    """Test handling of missing sequence numbers."""
    factual_claim = {"claim_text": "Test claim"}  # No sequence
    normative_claim = {"claim_text": "Test ought", "sequence": 5}

    # Should not crash, should return some default
    try:
        proximity = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim)
        assert 0.0 <= proximity <= 1.0
    except KeyError:
        pytest.fail("Should handle missing sequence gracefully")


def test_temporal_proximity_ordering(is_ought_detector):
    """Test that proximity decreases as distance increases."""
    factual_claim = {"sequence": 0}
    
    proximity_1 = is_ought_detector._calculate_temporal_proximity(factual_claim, {"sequence": 1})
    proximity_5 = is_ought_detector._calculate_temporal_proximity(factual_claim, {"sequence": 5})
    proximity_20 = is_ought_detector._calculate_temporal_proximity(factual_claim, {"sequence": 20})

    assert proximity_1 > proximity_5 > proximity_20


# =============================================================================
# Initialization Tests
# =============================================================================

def test_is_ought_detector_can_be_initialized(mock_db_session):
    """Test that IsOughtDetector can be initialized."""
    from services.is_ought_detector import IsOughtDetector
    
    detector = IsOughtDetector(mock_db_session)
    
    assert detector is not None
    assert detector.db == mock_db_session
    assert hasattr(detector, 'check_conflation')
    assert hasattr(detector, 'analyze_conversation')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
