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

class generateFormalismRequest(BaseModel):
    chunks: dict
    graph_data: List
    user_pref: str

class generateFormalismResponse(BaseModel):
    formalism_data: List

class SaveJsonResponseExtended(BaseModel):
    file_id: str
    file_name: str
    message: str
    no_of_nodes: int
    created_at: Optional[str]

class ConversationResponse(BaseModel):
    graph_data: List[Any]
    chunk_dict: Dict[str, Any]

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
