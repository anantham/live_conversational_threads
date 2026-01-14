"""
Tests for ArgumentMapper service - Premise → Conclusion Tree Detection

Run with: pytest tests/test_argument_mapper.py -v

Strategy: Test what's ACTUALLY testable without LLM calls:
- Initialization
- DB save operations
"""

import pytest
import uuid
import os
import sys
from unittest.mock import AsyncMock, Mock, MagicMock, patch

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
def argument_mapper(mock_db_session):
    """Create ArgumentMapper instance with mocked dependencies."""
    from services.argument_mapper import ArgumentMapper
    mapper = ArgumentMapper(mock_db_session)
    return mapper


# =============================================================================
# Initialization Tests
# =============================================================================

def test_argument_mapper_can_be_initialized(mock_db_session):
    """Test that ArgumentMapper can be initialized."""
    from services.argument_mapper import ArgumentMapper
    
    mapper = ArgumentMapper(mock_db_session)
    
    assert mapper is not None
    assert mapper.db == mock_db_session
    assert hasattr(mapper, 'build_argument_tree')
    assert hasattr(mapper, 'analyze_node')


# =============================================================================
# Database Save Tests - Test the plumbing, not the LLM
# =============================================================================

@pytest.mark.asyncio
async def test_save_argument_tree_calls_db(argument_mapper, mock_db_session):
    """Test that saving argument tree interacts with database correctly."""
    conversation_id = uuid.uuid4()
    node_id = uuid.uuid4()
    root_claim_id = uuid.uuid4()

    tree_data = {
        "argument_type": "deductive",
        "is_valid": True,
        "tree_structure": {"root": "test"},
        "confidence": 0.9
    }

    # Setup mock
    mock_db_session.add = Mock()
    mock_db_session.commit = AsyncMock()
    mock_db_session.refresh = AsyncMock()

    saved_tree = await argument_mapper._save_argument_tree(
        str(conversation_id),
        str(node_id),
        str(root_claim_id),
        tree_data
    )

    # Verify DB operations were called
    assert saved_tree is not None
    mock_db_session.add.assert_called_once()
    mock_db_session.commit.assert_called_once()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
