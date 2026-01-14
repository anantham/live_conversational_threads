"""
Pytest configuration and shared fixtures for Live Conversational Threads tests.

This module provides:
- Database fixtures (test database, session management)
- API client fixtures (for testing endpoints)
- Mock data factories (conversations, utterances, nodes)
- Invariant checking hooks
"""

import pytest
import os
import json
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


# ============================================================================
# Test Database Configuration
# ============================================================================

@pytest.fixture(scope="session")
def test_database_url():
    """Get test database URL from environment or use default."""
    return os.getenv("TEST_DATABASE_URL", "sqlite:///./lct_test.db")


@pytest.fixture(scope="session")
def test_engine(test_database_url):
    """Create test database engine."""
    engine = create_engine(
        test_database_url,
        connect_args={"check_same_thread": False} if "sqlite" in test_database_url else {}
    )
    return engine


@pytest.fixture(scope="function")
def db_session(test_engine):
    """
    Create a new database session for each test.
    Automatically rolls back after test completes.
    """
    connection = test_engine.connect()
    transaction = connection.begin()
    
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=connection)
    session = SessionLocal()
    
    yield session
    
    session.close()
    transaction.rollback()
    connection.close()


# ============================================================================
# Mock Database Helper (for tests without real DB)
# ============================================================================

class MockDB:
    """
    Mock database for testing invariants without a real database connection.
    Stores data in memory dictionaries.
    """
    
    def __init__(self):
        self.utterances = {}
        self.nodes = {}
        self.edges = {}
        self.api_call_logs = {}
    
    def get_utterances(self, conversation_id: str, order_by=None):
        """Get all utterances for a conversation."""
        utterances = [
            u for u in self.utterances.values()
            if u.conversation_id == conversation_id
        ]
        
        if order_by == "start_time":
            utterances.sort(key=lambda u: getattr(u, 'start_time', 0))
        
        return utterances
    
    def get_nodes(self, conversation_id: str, zoom_level=None):
        """Get nodes for a conversation, optionally filtered by zoom level."""
        nodes = [
            n for n in self.nodes.values()
            if n.conversation_id == conversation_id
        ]
        
        if zoom_level is not None:
            nodes = [
                n for n in nodes
                if getattr(n, 'zoom_level_visible', 1) <= zoom_level
            ]
        
        return nodes
    
    def get_edges(self, conversation_id: str, relationship_type=None):
        """Get edges for a conversation, optionally filtered by type."""
        edges = [
            e for e in self.edges.values()
            if e.conversation_id == conversation_id
        ]
        
        if relationship_type:
            edges = [
                e for e in edges
                if e.relationship_type == relationship_type
            ]
        
        return edges
    
    def get_utterance(self, utterance_id: str):
        """Get a single utterance by ID."""
        return self.utterances.get(utterance_id)
    
    def get_api_calls_log(self, conversation_id: str):
        """Get API call logs for a conversation."""
        return [
            log for log in self.api_call_logs.values()
            if log.conversation_id == conversation_id
        ]
    
    def get_instrumentation_events(self, conversation_id: str, event_type=None):
        """Get instrumentation events (mocked)."""
        # Mock implementation - return empty list for now
        return []


@pytest.fixture
def mock_db():
    """Provide a mock database for testing."""
    return MockDB()


# ============================================================================
# Mock API Client
# ============================================================================

class MockAPIClient:
    """Mock API client for testing endpoints without real HTTP calls."""
    
    def __init__(self, mock_db):
        self.mock_db = mock_db
    
    def get_timeline_view(self, conversation_id: str):
        """Mock timeline view endpoint."""
        utterances = self.mock_db.get_utterances(conversation_id, order_by="start_time")
        return [
            {"utterance_id": u.id, "text": u.text, "speaker": getattr(u, 'speaker_id', None)}
            for u in utterances
        ]
    
    def get_speaker_legend(self, conversation_id: str):
        """Mock speaker legend endpoint."""
        utterances = self.mock_db.get_utterances(conversation_id)
        unique_speakers = set(
            u.speaker_id for u in utterances
            if hasattr(u, 'speaker_id')
        )
        
        return [
            {"speaker_id": speaker, "color": f"#{''.join([hex(hash(speaker) >> i & 0xFF)[2:].zfill(2) for i in (0, 8, 16)])}"}
            for speaker in unique_speakers
        ]


@pytest.fixture
def mock_api_client(mock_db):
    """Provide a mock API client for testing."""
    return MockAPIClient(mock_db)


# ============================================================================
# Golden Dataset Fixtures
# ============================================================================

@pytest.fixture(scope="session")
def golden_datasets():
    """Load golden datasets with expected node counts."""
    fixtures_path = Path(__file__).parent / "fixtures" / "golden_datasets" / "expected_nodes.json"
    
    if fixtures_path.exists():
        with open(fixtures_path) as f:
            return json.load(f)
    else:
        # Return empty dict if file doesn't exist yet
        return {}


# ============================================================================
# Test Data Factories
# ============================================================================

from dataclasses import dataclass
from typing import Optional, List
import uuid


@dataclass
class MockUtterance:
    """Mock utterance object for testing."""
    id: str
    conversation_id: str
    text: str
    speaker_id: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None


@dataclass
class MockNode:
    """Mock node object for testing."""
    id: str
    conversation_id: str
    summary: str
    utterance_ids: List[str]
    zoom_level_visible: int = 1


@dataclass
class MockEdge:
    """Mock edge object for testing."""
    id: str
    conversation_id: str
    from_node_id: str
    to_node_id: str
    relationship_type: str = "temporal"


@dataclass
class MockAPICallLog:
    """Mock API call log for testing."""
    id: str
    conversation_id: str
    cost_usd: Optional[float] = None
    latency_ms: Optional[int] = None
    total_tokens: Optional[int] = None


def create_mock_utterance(
    conversation_id: str,
    text: str = "Test utterance",
    speaker_id: str = "Speaker 1",
    start_time: float = 0.0,
    end_time: float = 1.0
) -> MockUtterance:
    """Factory function to create mock utterances."""
    return MockUtterance(
        id=str(uuid.uuid4()),
        conversation_id=conversation_id,
        text=text,
        speaker_id=speaker_id,
        start_time=start_time,
        end_time=end_time
    )


def create_mock_conversation(
    utterance_count: int = 10,
    speakers: List[str] = None
) -> tuple[str, List[MockUtterance]]:
    """
    Factory function to create a full mock conversation.
    
    Returns:
        tuple: (conversation_id, list of utterances)
    """
    conversation_id = str(uuid.uuid4())
    
    if speakers is None:
        speakers = ["Speaker 1", "Speaker 2"]
    
    utterances = []
    for i in range(utterance_count):
        speaker = speakers[i % len(speakers)]
        utterance = create_mock_utterance(
            conversation_id=conversation_id,
            text=f"Utterance {i + 1} from {speaker}",
            speaker_id=speaker,
            start_time=float(i),
            end_time=float(i + 1)
        )
        utterances.append(utterance)
    
    return conversation_id, utterances


# ============================================================================
# Invariant Checking Hooks
# ============================================================================

@pytest.fixture
def check_invariants(mock_db, mock_api_client):
    """
    Provides a convenience function to check all invariants for a conversation.
    
    Usage:
        def test_something(check_invariants, mock_db):
            # ... create test data ...
            check_invariants(conversation_id)  # Will raise if invariants violated
    """
    from tests.invariants import check_all_invariants
    
    def _check(conversation_id: str):
        check_all_invariants(mock_db, mock_api_client, conversation_id)
    
    return _check


# ============================================================================
# Pytest Markers
# ============================================================================

def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )
    config.addinivalue_line(
        "markers", "integration: marks tests as integration tests"
    )
    config.addinivalue_line(
        "markers", "e2e: marks tests as end-to-end tests"
    )
    config.addinivalue_line(
        "markers", "audio: marks tests that require audio fixtures"
    )
