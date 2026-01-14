"""
Tests for ClaimDetector service - Three-Layer Claim Taxonomy

Run with: pytest tests/test_claim_detector.py -v

Strategy: Test what's ACTUALLY testable without LLM calls:
- Pure aggregation functions
- Edge case handling
- Initialization
"""

import pytest
import os
import sys
from unittest.mock import MagicMock, AsyncMock, patch

# Need to mock these before importing
sys.modules['anthropic'] = MagicMock()

# Set fake API keys for tests
os.environ.setdefault('OPENAI_API_KEY', 'test-key-for-testing')
os.environ.setdefault('ANTHROPIC_API_KEY', 'test-key-for-testing')


@pytest.fixture
def mock_db_session():
    """Mock database session for testing."""
    from sqlalchemy.ext.asyncio import AsyncSession
    session = AsyncMock(spec=AsyncSession)
    return session


@pytest.fixture
def claim_detector(mock_db_session):
    """Create ClaimDetector instance with mocked dependencies."""
    with patch('services.claim_detector.get_prompt_manager'), \
         patch('services.claim_detector.get_embedding_service'):
        from services.claim_detector import ClaimDetector
        detector = ClaimDetector(mock_db_session)
        return detector


# =============================================================================
# Pure Function Tests - These test real logic, no mocking needed
# =============================================================================

def test_claim_aggregation_by_type(claim_detector):
    """Test aggregation of claims by type across conversation."""
    claims = [
        {"claim_type": "factual", "strength": 0.9},
        {"claim_type": "factual", "strength": 0.85},
        {"claim_type": "normative", "strength": 0.8},
        {"claim_type": "normative", "strength": 0.75},
        {"claim_type": "normative", "strength": 0.9},
        {"claim_type": "worldview", "strength": 0.7},
    ]

    aggregated = claim_detector._aggregate_by_type(claims)

    assert aggregated["factual"] == 2
    assert aggregated["normative"] == 3
    assert aggregated["worldview"] == 1
    assert aggregated["total"] == 6


def test_claim_aggregation_by_speaker(claim_detector):
    """Test aggregation of claims by speaker."""
    claims = [
        {"speaker_name": "Alice", "claim_type": "factual"},
        {"speaker_name": "Alice", "claim_type": "normative"},
        {"speaker_name": "Bob", "claim_type": "worldview"},
        {"speaker_name": "Bob", "claim_type": "factual"},
    ]

    aggregated = claim_detector._aggregate_by_speaker(claims)

    assert aggregated["Alice"]["total"] == 2
    assert aggregated["Bob"]["total"] == 2
    assert aggregated["Alice"]["factual"] == 1
    assert aggregated["Alice"]["normative"] == 1


def test_claim_aggregation_empty_list(claim_detector):
    """Test aggregation handles empty claim list."""
    aggregated = claim_detector._aggregate_by_type([])

    assert aggregated["factual"] == 0
    assert aggregated["normative"] == 0
    assert aggregated["worldview"] == 0
    assert aggregated["total"] == 0


def test_claim_aggregation_by_speaker_empty(claim_detector):
    """Test speaker aggregation handles empty list."""
    aggregated = claim_detector._aggregate_by_speaker([])

    assert aggregated == {}


def test_claim_aggregation_missing_type(claim_detector):
    """Test aggregation handles claims with missing type gracefully."""
    claims = [
        {"claim_type": "factual"},
        {"speaker_name": "Alice"},  # Missing claim_type
        {"claim_type": "normative"},
    ]

    # Should not crash
    try:
        aggregated = claim_detector._aggregate_by_type(claims)
        # Missing type should be skipped or counted as unknown
        assert aggregated["total"] >= 2
    except KeyError:
        pytest.fail("Aggregation should handle missing claim_type")


# =============================================================================
# Initialization Tests
# =============================================================================

def test_claim_detector_can_be_initialized(mock_db_session):
    """Test that ClaimDetector can be initialized."""
    with patch('services.claim_detector.get_prompt_manager'):
        from services.claim_detector import ClaimDetector
        detector = ClaimDetector(mock_db_session)
        
        assert detector is not None
        assert detector.db == mock_db_session
        assert hasattr(detector, 'analyze_conversation')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
