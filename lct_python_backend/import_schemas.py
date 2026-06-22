"""Pydantic request/response schemas for the import API router."""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class UtteranceResponse(BaseModel):
    """Response model for utterance."""

    speaker: str
    text: str
    start_time: Optional[float]
    end_time: Optional[float]
    sequence_number: int

    model_config = ConfigDict(from_attributes=True)


class ValidationResponse(BaseModel):
    """Response model for validation result."""

    is_valid: bool
    errors: List[str]
    warnings: List[str]
    stats: dict


class ParsedTranscriptResponse(BaseModel):
    """Response model for parsed transcript."""

    conversation_id: str
    utterance_count: int
    participant_count: int
    participants: List[str]
    duration: Optional[float]
    validation: ValidationResponse
    sample_utterances: List[UtteranceResponse]


class ImportStatusResponse(BaseModel):
    """Response model for import status."""

    success: bool
    conversation_id: Optional[str]
    message: str
    utterance_count: int
    participant_count: int


class ImportFromUrlRequest(BaseModel):
    """Request model for importing from URL."""

    url: str
    conversation_name: Optional[str] = None
    owner_id: Optional[str] = None


class ImportFromTextRequest(BaseModel):
    """Request model for importing from text."""

    text: str
    conversation_name: Optional[str] = None
    owner_id: Optional[str] = None


class ServiceHealthInfo(BaseModel):
    """Health info for a single service."""

    healthy: bool
    backend: str
    latency_ms: Optional[int] = None
    url: Optional[str] = None
    model: Optional[str] = None
    error: Optional[str] = None


class ServicesStatusResponse(BaseModel):
    """Response model for service status endpoint."""

    services: Dict[str, ServiceHealthInfo]
    active_stt_backend: str
    active_llm_backend: str
    timestamp: str


class ImportTurnsResponse(BaseModel):
    """Response for the structured RawTurn import — surfaces auditability up front."""

    success: bool
    conversation_id: str
    utterance_count: int
    node_count: int
    auditable_node_count: int
    indrasnet_group_id: Optional[str] = None
    message: str


class ExtractTurnsRequest(BaseModel):
    """Phase-2 trigger: build the graph for turns already persisted by ``/turns``."""

    conversation_id: Optional[str] = None
    group_id: Optional[str] = None
    owner_id: Optional[str] = None