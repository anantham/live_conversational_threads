"""
Tests for ArgumentMapper service - Premise → Conclusion Tree Detection

Test-Driven Development: Define expected behavior before implementation.
"""

import pytest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from sqlalchemy.ext.asyncio import AsyncSession

from services.argument_mapper import ArgumentMapper
from models import ArgumentTree, Claim, Node


@pytest.fixture
def mock_db_session():
    """Mock database session for testing."""
    session = AsyncMock(spec=AsyncSession)
    return session


@pytest.fixture
def argument_mapper(mock_db_session):
    """Create ArgumentMapper instance with mocked dependencies."""
    mapper = ArgumentMapper(mock_db_session)
    return mapper


@pytest.mark.asyncio
async def test_argument_mapper_initialization(mock_db_session):
    """Test that ArgumentMapper can be initialized."""
    mapper = ArgumentMapper(mock_db_session)
    assert mapper is not None
    assert mapper.db == mock_db_session


@pytest.mark.asyncio
async def test_detect_simple_argument_structure(argument_mapper):
    """Test detection of simple premise → conclusion structure."""
    # Mock claims: "Markets are efficient" (premise) → "We should use free markets" (conclusion)
    claims = [
        {
            "id": str(uuid.uuid4()),
            "claim_text": "Markets efficiently allocate resources",
            "claim_type": "factual",
            "strength": 0.8
        },
        {
            "id": str(uuid.uuid4()),
            "claim_text": "We should rely on free markets for healthcare",
            "claim_type": "normative",
            "strength": 0.9
        }
    ]

    mock_response = {
        "argument_type": "deductive",
        "root_claim": claims[1]["claim_text"],
        "premises": [
            {
                "claim_text": claims[0]["claim_text"],
                "supports": claims[1]["claim_text"]
            }
        ],
        "is_valid": True,
        "confidence": 0.85
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result is not None
        assert result["argument_type"] == "deductive"
        assert result["is_valid"] is True
        assert len(result["premises"]) > 0


@pytest.mark.asyncio
async def test_detect_circular_reasoning(argument_mapper):
    """Test detection of circular dependencies in arguments."""
    # Circular: "God exists because the Bible says so, and the Bible is true because God wrote it"
    claims = [
        {
            "id": str(uuid.uuid4()),
            "claim_text": "The Bible is infallible",
            "claim_type": "worldview"
        },
        {
            "id": str(uuid.uuid4()),
            "claim_text": "God exists",
            "claim_type": "worldview"
        }
    ]

    mock_response = {
        "argument_type": "deductive",
        "root_claim": claims[1]["claim_text"],
        "premises": [{"claim_text": claims[0]["claim_text"]}],
        "circular_dependencies": [claims[0]["id"], claims[1]["id"]],
        "is_valid": False,
        "confidence": 0.9
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result["is_valid"] is False
        assert len(result.get("circular_dependencies", [])) > 0


@pytest.mark.asyncio
async def test_classify_argument_type_deductive(argument_mapper):
    """Test classification of deductive arguments."""
    # Deductive: "All humans are mortal. Socrates is human. Therefore, Socrates is mortal."
    claims = [
        {"claim_text": "All humans are mortal", "claim_type": "factual"},
        {"claim_text": "Socrates is human", "claim_type": "factual"},
        {"claim_text": "Socrates is mortal", "claim_type": "factual"}
    ]

    mock_response = {
        "argument_type": "deductive",
        "is_valid": True,
        "confidence": 0.95
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result["argument_type"] == "deductive"


@pytest.mark.asyncio
async def test_classify_argument_type_inductive(argument_mapper):
    """Test classification of inductive arguments."""
    # Inductive: "The sun rose every day for the past 10,000 years. The sun will rise tomorrow."
    claims = [
        {"claim_text": "The sun has risen every day historically", "claim_type": "factual"},
        {"claim_text": "The sun will rise tomorrow", "claim_type": "factual"}
    ]

    mock_response = {
        "argument_type": "inductive",
        "is_valid": True,
        "confidence": 0.8
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result["argument_type"] == "inductive"


@pytest.mark.asyncio
async def test_detect_nested_argument_structure(argument_mapper):
    """Test detection of multi-level argument trees."""
    # Complex: Multiple premises supporting intermediate conclusions
    claims = [
        {"claim_text": "Economic growth reduces poverty", "claim_type": "factual"},
        {"claim_text": "Poverty causes social unrest", "claim_type": "factual"},
        {"claim_text": "We should maximize economic growth", "claim_type": "normative"}
    ]

    mock_response = {
        "argument_type": "deductive",
        "root_claim": claims[2]["claim_text"],
        "tree_structure": {
            "conclusion": claims[2]["claim_text"],
            "premises": [
                {
                    "claim": claims[0]["claim_text"],
                    "premises": []  # Leaf premise
                },
                {
                    "claim": claims[1]["claim_text"],
                    "premises": []  # Leaf premise
                }
            ]
        },
        "depth": 2,
        "is_valid": True
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert "tree_structure" in result
        assert result["tree_structure"]["conclusion"] == claims[2]["claim_text"]


@pytest.mark.asyncio
async def test_detect_invalid_argument_structure(argument_mapper):
    """Test detection of logically invalid arguments."""
    # Invalid: "All cats are animals. All dogs are animals. Therefore, all dogs are cats."
    claims = [
        {"claim_text": "All cats are animals", "claim_type": "factual"},
        {"claim_text": "All dogs are animals", "claim_type": "factual"},
        {"claim_text": "All dogs are cats", "claim_type": "factual"}
    ]

    mock_response = {
        "argument_type": "deductive",
        "is_valid": False,
        "identified_fallacies": ["affirming_the_consequent"],
        "confidence": 0.9
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result["is_valid"] is False
        assert len(result.get("identified_fallacies", [])) > 0


@pytest.mark.asyncio
async def test_detect_soundness(argument_mapper):
    """Test detection of sound arguments (valid + true premises)."""
    claims = [
        {"claim_text": "All humans need oxygen", "claim_type": "factual", "verification_status": "verified"},
        {"claim_text": "Alice is human", "claim_type": "factual", "verification_status": "verified"},
        {"claim_text": "Alice needs oxygen", "claim_type": "factual"}
    ]

    mock_response = {
        "argument_type": "deductive",
        "is_valid": True,
        "is_sound": True,  # Valid + all premises verified
        "confidence": 0.95
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result["is_valid"] is True
        assert result.get("is_sound") is True


@pytest.mark.asyncio
async def test_extract_premises_and_conclusions(argument_mapper):
    """Test extraction of all premises and conclusions from tree."""
    claims = [
        {"id": str(uuid.uuid4()), "claim_text": "Premise 1"},
        {"id": str(uuid.uuid4()), "claim_text": "Premise 2"},
        {"id": str(uuid.uuid4()), "claim_text": "Conclusion"}
    ]

    mock_response = {
        "premise_claim_ids": [claims[0]["id"], claims[1]["id"]],
        "conclusion_claim_ids": [claims[2]["id"]]
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert len(result.get("premise_claim_ids", [])) == 2
        assert len(result.get("conclusion_claim_ids", [])) == 1


@pytest.mark.asyncio
async def test_generate_visualization_data(argument_mapper):
    """Test generation of visualization data for UI rendering."""
    claims = [
        {"id": str(uuid.uuid4()), "claim_text": "Premise"},
        {"id": str(uuid.uuid4()), "claim_text": "Conclusion"}
    ]

    mock_response = {
        "visualization_data": {
            "nodes": [
                {"id": claims[0]["id"], "label": "Premise", "type": "premise"},
                {"id": claims[1]["id"], "label": "Conclusion", "type": "conclusion"}
            ],
            "edges": [
                {"from": claims[0]["id"], "to": claims[1]["id"], "label": "supports"}
            ]
        }
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert "visualization_data" in result
        assert "nodes" in result["visualization_data"]
        assert "edges" in result["visualization_data"]


@pytest.mark.asyncio
async def test_handle_no_argument_structure(argument_mapper):
    """Test handling when claims don't form a coherent argument."""
    # Unrelated claims
    claims = [
        {"claim_text": "The sky is blue"},
        {"claim_text": "Pizza is delicious"}
    ]

    mock_response = {
        "has_argument": False,
        "reason": "Claims are unrelated and don't form an argument structure"
    }

    with patch.object(argument_mapper, '_call_llm_for_argument_structure', return_value=mock_response):
        result = await argument_mapper.build_argument_tree(claims)

        assert result.get("has_argument") is False


@pytest.mark.asyncio
async def test_database_save_argument_tree(argument_mapper, mock_db_session):
    """Test saving argument tree to database."""
    conversation_id = uuid.uuid4()
    node_id = uuid.uuid4()
    root_claim_id = uuid.uuid4()

    tree_data = {
        "argument_type": "deductive",
        "is_valid": True,
        "tree_structure": {"root": "test"},
        "confidence": 0.9
    }

    # Mock session operations
    mock_db_session.add = Mock()
    mock_db_session.commit = AsyncMock()
    mock_db_session.refresh = AsyncMock()

    saved_tree = await argument_mapper._save_argument_tree(
        str(conversation_id),
        str(node_id),
        str(root_claim_id),
        tree_data
    )

    assert saved_tree is not None
    mock_db_session.add.assert_called_once()
    mock_db_session.commit.assert_called_once()


@pytest.mark.asyncio
async def test_analyze_node_for_arguments(argument_mapper):
    """Test analyzing a full node for argument structures."""
    node_id = str(uuid.uuid4())
    conversation_id = uuid.uuid4()

    # Mock getting claims from node
    mock_claims = [
        {"id": str(uuid.uuid4()), "claim_text": "Premise", "claim_type": "factual"},
        {"id": str(uuid.uuid4()), "claim_text": "Conclusion", "claim_type": "normative"}
    ]

    # Mock node
    mock_node = Mock()
    mock_node.id = uuid.UUID(node_id)
    mock_node.conversation_id = conversation_id

    mock_saved_tree = {
        "id": str(uuid.uuid4()),
        "argument_type": "deductive",
        "has_argument": True
    }

    # Use AsyncMock for async methods
    argument_mapper._get_node_argument_tree = AsyncMock(return_value=None)  # No existing tree
    argument_mapper._get_node_claims = AsyncMock(return_value=mock_claims)
    argument_mapper.build_argument_tree = AsyncMock(return_value={"argument_type": "deductive", "has_argument": True, "root_claim_id": str(uuid.uuid4())})
    argument_mapper._get_node = AsyncMock(return_value=mock_node)
    argument_mapper._save_argument_tree = AsyncMock(return_value=mock_saved_tree)

    result = await argument_mapper.analyze_node(node_id)

    assert result is not None
    assert "argument_type" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
