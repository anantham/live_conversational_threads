"""
Tests for ClaimDetector service - Three-Layer Claim Taxonomy

Test-Driven Development: These tests define expected behavior before implementation.
"""

import pytest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from sqlalchemy.ext.asyncio import AsyncSession

from services.claim_detector import ClaimDetector
from models import Claim, Node, Conversation, Utterance
from tests.fixtures.synthetic_claim_conversations import (
    ECONOMIC_POLICY_CONVERSATION,
    AI_SAFETY_CONVERSATION,
    CLIMATE_CONVERSATION,
    get_all_test_conversations
)


@pytest.fixture
def mock_db_session():
    """Mock database session for testing."""
    session = AsyncMock(spec=AsyncSession)
    return session


@pytest.fixture
def claim_detector(mock_db_session):
    """Create ClaimDetector instance with mocked dependencies."""
    with patch('services.claim_detector.get_prompt_manager'):
        detector = ClaimDetector(mock_db_session)
        return detector


@pytest.mark.asyncio
async def test_claim_detector_initialization(mock_db_session):
    """Test that ClaimDetector can be initialized."""
    with patch('services.claim_detector.get_prompt_manager'):
        detector = ClaimDetector(mock_db_session)
        assert detector is not None
        assert detector.db == mock_db_session


@pytest.mark.asyncio
async def test_detect_factual_claim(claim_detector):
    """Test detection of factual claims - verifiable statements."""
    # Test data: "GDP grew by 3.2% last quarter"
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Alice",
            "text": "GDP grew by 3.2% last quarter according to the latest report.",
            "sequence_number": 0
        }
    ]

    # Mock LLM response
    mock_response = {
        "claims": [
            {
                "claim_text": "GDP grew by 3.2% last quarter",
                "claim_type": "factual",
                "speaker": "Alice",
                "utterance_indices": [0],
                "strength": 0.9,
                "confidence": 0.95,
                "is_verifiable": True,
            }
        ]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert claim["claim_type"] == "factual"
        assert claim["is_verifiable"] is True
        assert "GDP grew by 3.2%" in claim["claim_text"]
        assert claim["strength"] > 0.8
        assert claim["confidence"] > 0.8


@pytest.mark.asyncio
async def test_detect_normative_claim(claim_detector):
    """Test detection of normative claims - value judgments and prescriptions."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Bob",
            "text": "We should prioritize reducing income inequality over pure growth.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [
            {
                "claim_text": "We should prioritize reducing income inequality over pure growth",
                "claim_type": "normative",
                "speaker": "Bob",
                "utterance_indices": [0],
                "strength": 0.95,
                "confidence": 0.9,
                "normative_type": "prescription",
                "implicit_values": ["fairness", "equality"],
            }
        ]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert claim["claim_type"] == "normative"
        assert claim["normative_type"] == "prescription"
        assert "fairness" in claim["implicit_values"]
        assert "equality" in claim["implicit_values"]
        assert "should" in claim["claim_text"]


@pytest.mark.asyncio
async def test_detect_worldview_claim(claim_detector):
    """Test detection of worldview claims - implicit ideological frames."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Alice",
            "text": "A rising tide lifts all boats. Economic growth naturally benefits everyone.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [
            {
                "claim_text": "Economic growth naturally benefits everyone",
                "claim_type": "worldview",
                "speaker": "Alice",
                "utterance_indices": [0],
                "strength": 0.85,
                "confidence": 0.8,
                "worldview_category": "economic_neoliberal",
                "hidden_premises": [
                    "Markets efficiently distribute benefits",
                    "Growth is inherently good"
                ],
                "ideological_markers": ["rising tide lifts all boats", "naturally"],
            }
        ]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert claim["claim_type"] == "worldview"
        assert claim["worldview_category"] == "economic_neoliberal"
        assert len(claim["hidden_premises"]) > 0
        assert len(claim["ideological_markers"]) > 0
        assert "rising tide" in claim["ideological_markers"]


@pytest.mark.asyncio
async def test_detect_multiple_claims_in_single_utterance(claim_detector):
    """Test detection when single utterance contains multiple claims."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Diana",
            "text": "I think AI will be beneficial overall, but we need safeguards.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [
            {
                "claim_text": "AI will be beneficial overall",
                "claim_type": "normative",
                "speaker": "Diana",
                "utterance_indices": [0],
                "strength": 0.7,
                "confidence": 0.75,
                "normative_type": "evaluation",
                "implicit_values": ["optimism", "progress"],
            },
            {
                "claim_text": "We need safeguards for AI",
                "claim_type": "normative",
                "speaker": "Diana",
                "utterance_indices": [0],
                "strength": 0.85,
                "confidence": 0.9,
                "normative_type": "prescription",
                "implicit_values": ["safety", "prudence"],
            }
        ]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 2
        assert claims[0]["claim_type"] == "normative"
        assert claims[1]["claim_type"] == "normative"
        assert claims[0]["normative_type"] == "evaluation"
        assert claims[1]["normative_type"] == "prescription"


@pytest.mark.asyncio
async def test_naturalistic_fallacy_detection(claim_detector):
    """Test detection of naturalistic fallacy (is → ought conflation)."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Frank",
            "text": "Humans evolved to adapt to changing climates, so we'll naturally adjust to warming.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [
            {
                "claim_text": "We'll naturally adjust to warming because humans evolved to adapt",
                "claim_type": "worldview",
                "speaker": "Frank",
                "utterance_indices": [0],
                "strength": 0.8,
                "confidence": 0.85,
                "worldview_category": "naturalistic_fallacy",
                "hidden_premises": [
                    "What is natural is good",
                    "Past adaptation guarantees future success"
                ],
                "ideological_markers": ["naturally", "evolved to"],
            }
        ]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert claim["worldview_category"] == "naturalistic_fallacy"
        assert "naturally" in claim["ideological_markers"]


@pytest.mark.asyncio
async def test_conversation_level_analysis(claim_detector):
    """Test analyzing entire conversation for all three types of claims."""
    conversation_id = str(uuid.uuid4())

    # Mock database queries
    mock_nodes = [
        Mock(
            id=uuid.uuid4(),
            title="Economic Discussion",
            summary="Discussion about growth vs equality",
            utterance_ids=[uuid.uuid4() for _ in range(4)]
        )
    ]

    claim_detector.db.execute = AsyncMock(return_value=Mock(
        scalars=Mock(return_value=Mock(all=Mock(return_value=mock_nodes)))
    ))

    # Mock utterance fetching
    mock_utterances = [
        Mock(
            id=uuid.uuid4(),
            speaker_name="Alice",
            text="GDP grew by 3.2% last quarter.",
            sequence_number=0
        ),
        Mock(
            id=uuid.uuid4(),
            speaker_name="Bob",
            text="We should prioritize equality.",
            sequence_number=1
        ),
    ]

    with patch.object(claim_detector, '_get_node_utterances', return_value=mock_utterances):
        with patch.object(claim_detector, '_extract_claims_from_utterances', return_value=[
            {"claim_type": "factual", "claim_text": "GDP grew by 3.2%"},
            {"claim_type": "normative", "claim_text": "We should prioritize equality"},
        ]):
            result = await claim_detector.analyze_conversation(conversation_id)

            assert "total_claims" in result
            assert "by_type" in result
            assert result["total_claims"] > 0


@pytest.mark.asyncio
async def test_claim_strength_calculation(claim_detector):
    """Test that claim strength reflects centrality to argument."""
    # Central claim should have high strength
    central_utterance = {
        "id": str(uuid.uuid4()),
        "speaker_name": "Alice",
        "text": "Healthcare is a human right and should be provided to everyone.",
        "sequence_number": 0
    }

    # Peripheral claim should have lower strength
    peripheral_utterance = {
        "id": str(uuid.uuid4()),
        "speaker_name": "Bob",
        "text": "I think maybe we could consider universal healthcare.",
        "sequence_number": 1
    }

    mock_response_central = {
        "claims": [{
            "claim_text": "Healthcare is a human right",
            "claim_type": "normative",
            "speaker": "Alice",
            "utterance_indices": [0],
            "strength": 0.95,  # High - central claim
            "confidence": 0.9,
        }]
    }

    mock_response_peripheral = {
        "claims": [{
            "claim_text": "We could consider universal healthcare",
            "claim_type": "normative",
            "speaker": "Bob",
            "utterance_indices": [1],
            "strength": 0.4,  # Low - hedged, peripheral
            "confidence": 0.85,
        }]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response_central):
        central_claims = await claim_detector._extract_claims_from_utterances([central_utterance])
        assert central_claims[0]["strength"] > 0.8

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response_peripheral):
        peripheral_claims = await claim_detector._extract_claims_from_utterances([peripheral_utterance])
        assert peripheral_claims[0]["strength"] < 0.6


@pytest.mark.asyncio
async def test_claim_aggregation_by_type(claim_detector):
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


@pytest.mark.asyncio
async def test_claim_aggregation_by_speaker(claim_detector):
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


@pytest.mark.asyncio
async def test_no_claims_in_casual_utterance(claim_detector):
    """Test that casual conversation without claims returns empty list."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Alice",
            "text": "Hey, how are you doing today?",
            "sequence_number": 0
        }
    ]

    mock_response = {"claims": []}

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 0


@pytest.mark.asyncio
async def test_claim_confidence_thresholds(claim_detector):
    """Test that low-confidence claims are appropriately marked."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Alice",
            "text": "I'm not sure, but maybe economic growth helps everyone?",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [{
            "claim_text": "Economic growth helps everyone",
            "claim_type": "worldview",
            "speaker": "Alice",
            "utterance_indices": [0],
            "strength": 0.4,  # Low - hedged statement
            "confidence": 0.6,  # Low - uncertain classification
        }]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        # Low confidence claims should still be detected but marked as such
        assert claims[0]["confidence"] < 0.7
        assert claims[0]["strength"] < 0.5


@pytest.mark.asyncio
async def test_implicit_values_extraction(claim_detector):
    """Test extraction of implicit values from normative claims."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Henry",
            "text": "Healthcare is a human right and should be provided to everyone.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [{
            "claim_text": "Healthcare is a human right and should be provided to everyone",
            "claim_type": "normative",
            "speaker": "Henry",
            "utterance_indices": [0],
            "strength": 0.95,
            "confidence": 0.9,
            "normative_type": "prescription",
            "implicit_values": ["equality", "human dignity", "solidarity"],
        }]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert len(claim["implicit_values"]) > 0
        assert "equality" in claim["implicit_values"]
        assert "human dignity" in claim["implicit_values"]


@pytest.mark.asyncio
async def test_hidden_premises_extraction(claim_detector):
    """Test extraction of hidden premises from worldview claims."""
    utterances = [
        {
            "id": str(uuid.uuid4()),
            "speaker_name": "Grace",
            "text": "Free markets always produce better outcomes than government programs.",
            "sequence_number": 0
        }
    ]

    mock_response = {
        "claims": [{
            "claim_text": "Free markets always produce better outcomes than government programs",
            "claim_type": "worldview",
            "speaker": "Grace",
            "utterance_indices": [0],
            "strength": 0.9,
            "confidence": 0.85,
            "worldview_category": "economic_libertarian",
            "hidden_premises": [
                "Markets are inherently efficient",
                "Government is inherently inefficient",
                "Individual choice maximizes welfare"
            ],
            "ideological_markers": ["free markets", "always produce better"],
        }]
    }

    with patch.object(claim_detector, '_call_llm_for_claims', return_value=mock_response):
        claims = await claim_detector._extract_claims_from_utterances(utterances)

        assert len(claims) == 1
        claim = claims[0]
        assert len(claim["hidden_premises"]) >= 2
        assert any("efficient" in premise.lower() for premise in claim["hidden_premises"])


@pytest.mark.asyncio
async def test_database_save_claim(claim_detector, mock_db_session):
    """Test saving claim to database."""
    conversation_id = uuid.uuid4()
    node_id = uuid.uuid4()

    claim_data = {
        "claim_text": "GDP grew by 3.2% last quarter",
        "claim_type": "factual",
        "speaker": "Alice",
        "utterance_indices": [0],
        "strength": 0.9,
        "confidence": 0.95,
        "is_verifiable": True,
    }

    utterances = [Mock(id=uuid.uuid4())]

    # Mock session operations
    mock_db_session.add = Mock()
    mock_db_session.commit = AsyncMock()
    mock_db_session.refresh = AsyncMock()

    saved_claim = await claim_detector._save_claim(
        str(conversation_id),
        str(node_id),
        claim_data,
        utterances
    )

    assert saved_claim["claim_text"] == claim_data["claim_text"]
    assert saved_claim["claim_type"] == claim_data["claim_type"]
    mock_db_session.add.assert_called_once()
    mock_db_session.commit.assert_called_once()


# Integration tests with synthetic conversations
@pytest.mark.asyncio
@pytest.mark.integration
async def test_economic_policy_conversation_full_analysis(claim_detector):
    """Integration test: Full analysis of economic policy conversation."""
    # This would use ECONOMIC_POLICY_CONVERSATION fixture
    # and validate all expected claims are detected
    pass  # Implement when service is complete


@pytest.mark.asyncio
@pytest.mark.integration
async def test_ai_safety_conversation_full_analysis(claim_detector):
    """Integration test: Full analysis of AI safety conversation."""
    pass  # Implement when service is complete


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
