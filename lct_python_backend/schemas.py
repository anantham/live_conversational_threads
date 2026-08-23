"""Shared Pydantic request/response models used across multiple routers."""
from pydantic import BaseModel, HttpUrl
from typing import Dict, List, Any, Optional


class TranscriptRequest(BaseModel):
    transcript: str

class ChunkedTranscript(BaseModel):
    chunks: Dict[str, str]  # Dictionary where keys are UUIDs and values are text chunks

class ChunkedRequest(BaseModel):
    chunks: Dict[str, str]  # Input to the streaming endpoint

class ProcessedChunk(BaseModel):
    chunk_id: str
    text: str

class SaveJsonRequest(BaseModel):
    file_name: str
    chunks: dict
    graph_data: List
    conversation_id: str

class SaveJsonResponse(BaseModel):
    message: str
    file_id: str  # UUID of the saved file
    file_name: str  # Original file name provided by the user

class SaveJsonResponseExtended(BaseModel):
    file_id: str
    file_name: str
    message: str
    no_of_nodes: int
    created_at: Optional[str]
    conversation_type: Optional[str] = None
    duration_seconds: Optional[int] = None
    started_at: Optional[str] = None
    total_utterances: Optional[int] = None
    # Participant list (JSONB) so the Browse contact filter can scope
    # "conversations with <contact>". Each entry: {contact_id|null, display_name, ...}.
    # Defaults to [] for legacy rows that never had a participant picker run.
    participants: Optional[List[Any]] = None

class ConversationResponse(BaseModel):
    graph_data: List[Any]
    chunk_dict: Dict[str, Any]
    # Canonical directed relationship contract. Node-local edge_relations stays
    # read-compatible, but new consumers use these explicit endpoints.
    edge_schema: Optional[Dict[str, Any]] = None
    edges: Optional[List[Dict[str, Any]]] = None
    # A7: surfaced at the top of the conversation view as a banner.
    # Populated by the arcs consolidation pass (A4). Optional so legacy
    # imports without consolidation just don't render the banner.
    conversation_title: Optional[str] = None
    executive_summary: Optional[str] = None

class Citation(BaseModel):
    title: str
    url: HttpUrl

class AnswerFormat(BaseModel):
    claim: str
    verdict: str  # "True", "False", "Unverified"
    explanation: str
    citations: List[Citation]  # max 2 preferred

class ClaimsResponse(BaseModel):
    claims: List[AnswerFormat]

class FactCheckRequest(BaseModel):
    claims: List[str]

class SaveFactCheckRequest(BaseModel):
    conversation_id: str
    node_name: str
    fact_check_data: List[AnswerFormat]

class GetFactCheckResponse(BaseModel):
    results: List[AnswerFormat]
