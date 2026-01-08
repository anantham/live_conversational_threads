"""
Tests for IsOughtDetector service - Naturalistic Fallacy Detection

Detects when speakers jump from descriptive claims (is) to normative claims (ought)
without justification.
"""

import pytest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from sqlalchemy.ext.asyncio import AsyncSession

from services.is_ought_detector import IsOughtDetector
from models import IsOughtConflation, Claim


@pytest.fixture
def mock_db_session():
    """Mock database session for testing."""
    session = AsyncMock(spec=AsyncSession)
    return session


@pytest.fixture
def is_ought_detector(mock_db_session):
    """Create IsOughtDetector instance with mocked dependencies."""
    detector = IsOughtDetector(mock_db_session)
    return detector


@pytest.mark.asyncio
async def test_is_ought_detector_initialization(mock_db_session):
    """Test that IsOughtDetector can be initialized."""
    detector = IsOughtDetector(mock_db_session)
    assert detector is not None
    assert detector.db == mock_db_session


@pytest.mark.asyncio
async def test_detect_basic_naturalistic_fallacy(is_ought_detector):
    """Test detection of classic naturalistic fallacy."""
    # "Humans naturally seek wealth, therefore capitalism is right"
    factual_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Humans naturally seek to accumulate wealth",
        "claim_type": "factual",
        "sequence": 0
    }

    normative_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Therefore, capitalism is the right economic system",
        "claim_type": "normative",
        "sequence": 1
    }

    mock_response = {
        "is_conflation": True,
        "fallacy_type": "naturalistic_fallacy",
        "explanation": "Jumps from what humans naturally do (descriptive) to what economic system we should have (normative) without justification",
        "strength": 0.85,
        "confidence": 0.9
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(factual_claim, normative_claim)

        assert result["is_conflation"] is True
        assert result["fallacy_type"] == "naturalistic_fallacy"
        assert result["strength"] > 0.8


@pytest.mark.asyncio
async def test_detect_appeal_to_nature(is_ought_detector):
    """Test detection of appeal to nature fallacy."""
    # "Humans evolved to eat meat, so eating meat is morally good"
    factual_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Humans evolved as omnivores and have eaten meat for millions of years",
        "claim_type": "factual"
    }

    normative_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Eating meat is morally acceptable",
        "claim_type": "normative"
    }

    mock_response = {
        "is_conflation": True,
        "fallacy_type": "appeal_to_nature",
        "explanation": "Assumes that what is natural is morally good (is → ought)",
        "strength": 0.8,
        "confidence": 0.85
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(factual_claim, normative_claim)

        assert result["is_conflation"] is True
        assert result["fallacy_type"] == "appeal_to_nature"


@pytest.mark.asyncio
async def test_detect_appeal_to_tradition(is_ought_detector):
    """Test detection of appeal to tradition."""
    # "We've always done it this way, so we should continue"
    factual_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "This organization has used this process for 50 years",
        "claim_type": "factual"
    }

    normative_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "We should continue using this process",
        "claim_type": "normative"
    }

    mock_response = {
        "is_conflation": True,
        "fallacy_type": "appeal_to_tradition",
        "explanation": "Assumes that because something has been done historically, it should continue (is → ought)",
        "strength": 0.75,
        "confidence": 0.8
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(factual_claim, normative_claim)

        assert result["is_conflation"] is True
        assert result["fallacy_type"] == "appeal_to_tradition"


@pytest.mark.asyncio
async def test_detect_no_conflation_justified_inference(is_ought_detector):
    """Test that justified inferences are not flagged as conflations."""
    # "All humans deserve dignity" (normative premise) + "Alice is human" (fact) → "Alice deserves dignity" (valid)
    factual_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Alice is a human being",
        "claim_type": "factual"
    }

    normative_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Alice deserves to be treated with dignity",
        "claim_type": "normative"
    }

    mock_response = {
        "is_conflation": False,
        "reason": "Normative claim is justified by prior normative premise 'all humans deserve dignity', not an is-ought jump",
        "confidence": 0.8
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(factual_claim, normative_claim)

        assert result["is_conflation"] is False


@pytest.mark.asyncio
async def test_detect_temporal_proximity_matters(is_ought_detector):
    """Test that temporal proximity affects conflation detection."""
    # Claims far apart are less likely to be conflations
    factual_claim = {"claim_text": "The economy grew 3%", "sequence": 0}
    normative_claim_near = {"claim_text": "We should continue this policy", "sequence": 1}
    normative_claim_far = {"claim_text": "We should continue this policy", "sequence": 50}

    # Near claims more likely to be conflation
    mock_response_near = {"is_conflation": True, "strength": 0.8}
    # Far claims less likely
    mock_response_far = {"is_conflation": False}

    # Test temporal proximity logic
    proximity_near = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim_near)
    proximity_far = is_ought_detector._calculate_temporal_proximity(factual_claim, normative_claim_far)

    assert proximity_near > proximity_far


@pytest.mark.asyncio
async def test_analyze_conversation_for_conflations(is_ought_detector):
    """Test analyzing entire conversation for is-ought conflations."""
    conversation_id = str(uuid.uuid4())

    # Mock claims from conversation
    mock_claims = [
        {"id": str(uuid.uuid4()), "claim_type": "factual", "claim_text": "Markets are efficient", "sequence": 0},
        {"id": str(uuid.uuid4()), "claim_type": "normative", "claim_text": "We should use free markets", "sequence": 1},
        {"id": str(uuid.uuid4()), "claim_type": "factual", "claim_text": "The meeting was long", "sequence": 2},
    ]

    with patch.object(is_ought_detector, '_get_conversation_claims', return_value=mock_claims):
        with patch.object(is_ought_detector, 'check_conflation', return_value={"is_conflation": True, "strength": 0.8}):
            result = await is_ought_detector.analyze_conversation(conversation_id)

            assert "total_conflations" in result
            assert "conflations" in result


@pytest.mark.asyncio
async def test_strength_scoring(is_ought_detector):
    """Test that strength scoring reflects obviousness of conflation."""
    # Obvious conflation should have high strength
    obvious = {
        "factual": {"claim_text": "Humans evolved this way"},
        "normative": {"claim_text": "This is how we should behave"}
    }

    # Subtle conflation should have lower strength
    subtle = {
        "factual": {"claim_text": "Most companies use this approach"},
        "normative": {"claim_text": "We should consider this approach"}
    }

    mock_obvious = {"is_conflation": True, "strength": 0.9}
    mock_subtle = {"is_conflation": True, "strength": 0.5}

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_obvious):
        result_obvious = await is_ought_detector.check_conflation(obvious["factual"], obvious["normative"])
        assert result_obvious["strength"] > 0.8

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_subtle):
        result_subtle = await is_ought_detector.check_conflation(subtle["factual"], subtle["normative"])
        assert result_subtle["strength"] < 0.7


@pytest.mark.asyncio
async def test_database_save_conflation(is_ought_detector, mock_db_session):
    """Test saving is-ought conflation to database."""
    conversation_id = uuid.uuid4()
    node_id = uuid.uuid4()
    descriptive_claim_id = uuid.uuid4()
    normative_claim_id = uuid.uuid4()

    conflation_data = {
        "fallacy_type": "naturalistic_fallacy",
        "explanation": "Test explanation",
        "strength": 0.85,
        "confidence": 0.9,
        "utterance_ids": [uuid.uuid4()],
        "speaker_name": "Alice"
    }

    # Mock session operations
    mock_db_session.add = Mock()
    mock_db_session.commit = AsyncMock()
    mock_db_session.refresh = AsyncMock()

    saved_conflation = await is_ought_detector._save_conflation(
        str(conversation_id),
        str(node_id),
        str(descriptive_claim_id),
        str(normative_claim_id),
        conflation_data
    )

    assert saved_conflation is not None
    mock_db_session.add.assert_called_once()
    mock_db_session.commit.assert_called_once()


@pytest.mark.asyncio
async def test_filter_by_confidence_threshold(is_ought_detector):
    """Test that low-confidence conflations are filtered out."""
    conversation_id = str(uuid.uuid4())

    mock_claims = [
        {"id": str(uuid.uuid4()), "claim_type": "factual", "sequence": 0},
        {"id": str(uuid.uuid4()), "claim_type": "normative", "sequence": 1}
    ]

    # Low confidence conflation should be filtered
    mock_response_low = {"is_conflation": True, "confidence": 0.5}

    with patch.object(is_ought_detector, '_get_conversation_claims', return_value=mock_claims):
        with patch.object(is_ought_detector, 'check_conflation', return_value=mock_response_low):
            result = await is_ought_detector.analyze_conversation(conversation_id, confidence_threshold=0.7)

            # Should be filtered out
            assert result["total_conflations"] == 0


@pytest.mark.asyncio
async def test_conflation_text_extraction(is_ought_detector):
    """Test extraction of full text showing the conflation."""
    factual_claim = {
        "claim_text": "Humans evolved to eat meat",
        "utterance_ids": [uuid.uuid4()]
    }

    normative_claim = {
        "claim_text": "Eating meat is morally acceptable",
        "utterance_ids": [uuid.uuid4()]
    }

    mock_response = {
        "is_conflation": True,
        "conflation_text": "Humans evolved to eat meat, therefore eating meat is morally acceptable",
        "fallacy_type": "appeal_to_nature"
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(factual_claim, normative_claim)

        assert "conflation_text" in result
        assert "evolved" in result["conflation_text"]
        assert "morally" in result["conflation_text"]


@pytest.mark.asyncio
async def test_handle_worldview_claims_as_descriptive(is_ought_detector):
    """Test that worldview claims can also be used in is-ought conflations."""
    # Worldview claims often contain hidden "is" statements
    worldview_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "Markets naturally optimize outcomes",
        "claim_type": "worldview",  # Contains hidden factual assumption
        "hidden_premises": ["Markets are inherently efficient"]
    }

    normative_claim = {
        "id": str(uuid.uuid4()),
        "claim_text": "We should minimize government intervention",
        "claim_type": "normative"
    }

    mock_response = {
        "is_conflation": True,
        "fallacy_type": "naturalistic_fallacy",
        "explanation": "Assumes that natural optimization (descriptive) justifies minimal intervention (prescriptive)",
        "strength": 0.8
    }

    with patch.object(is_ought_detector, '_call_llm_for_conflation_check', return_value=mock_response):
        result = await is_ought_detector.check_conflation(worldview_claim, normative_claim)

        assert result["is_conflation"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
