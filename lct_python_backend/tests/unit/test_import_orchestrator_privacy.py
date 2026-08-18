"""Privacy routing contract for persisted-turn graph extraction.

Test Intent:
- Extraction passes only conversation-authorized providers to the processor.
- Denying external inference also disables the direct online-model branch.
- The observable extraction result still persists an auditable graph.
"""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from lct_python_backend.services.import_pipeline.import_orchestrator import (
    extract_graph_for_conversation,
)


class _ConversationResult:
    def __init__(self, conversation):
        self._conversation = conversation

    def scalar_one_or_none(self):
        return self._conversation


class _UtteranceResult:
    def __init__(self, utterances):
        self._utterances = utterances

    def scalars(self):
        return self

    def all(self):
        return self._utterances


class _FakeDb:
    def __init__(self, conversation, utterances):
        self._results = iter(
            [_ConversationResult(conversation), _UtteranceResult(utterances)]
        )

    async def execute(self, _query):
        return next(self._results)


@pytest.mark.asyncio
async def test_extract_graph_enforces_conversation_provider_policy(monkeypatch):
    conversation_id = uuid.uuid4()
    conversation = SimpleNamespace(
        id=conversation_id,
        owner_id="owner",
        deleted_at=None,
        conversation_name="Private meeting",
        source_type="indrasnet_raw_turns",
        indrasnet_group_id="group-1",
        source_metadata={
            "privacy": {"local_llm_ok": True, "external_llm_ok": False}
        },
    )
    utterance = SimpleNamespace(
        id=uuid.uuid4(),
        text="A private test utterance",
        speaker_id="SPEAKER_00",
        sequence_number=0,
        timestamp_start=0.0,
        timestamp_end=1.0,
        source_identifier="turn-1",
        platform_metadata={},
    )

    from lct_python_backend.services import graph_persistence, llm_config, owner_context
    from lct_python_backend.services.import_pipeline import import_hierarchy_repair
    from lct_python_backend.services.transcript import transcript_processing

    monkeypatch.setattr(owner_context, "resolve_owner_id", lambda owner_id: owner_id)
    monkeypatch.setattr(
        llm_config,
        "load_llm_config",
        AsyncMock(return_value={"mode": "online", "chat_model": "cloud-model"}),
    )
    monkeypatch.setattr(
        llm_config,
        "load_llm_providers",
        AsyncMock(
            return_value={
                "providers": [
                    {"id": "m5", "enabled": True, "trust_scope": "owner_private"},
                    {"id": "cloud", "enabled": True, "trust_scope": "external"},
                ]
            }
        ),
    )
    monkeypatch.setattr(
        import_hierarchy_repair,
        "repair_chunk_idea_hierarchy",
        AsyncMock(return_value=None),
    )
    persist_graph = AsyncMock(return_value=1)
    monkeypatch.setattr(graph_persistence, "persist_graph", persist_graph)

    observed = {}

    class _RecordingProcessor:
        def __init__(self, *, llm_config, providers, **_kwargs):
            observed["llm_config"] = llm_config
            observed["providers"] = providers
            self.existing_json = []
            self.chunk_utterance_map = {}

        async def handle_final_text(self, _text, *, utterance_id, **_kwargs):
            self.existing_json.append(
                {
                    "id": "chunk-1",
                    "node_name": "Private test",
                    "summary": "Private test",
                    "semantic_level": 1,
                    "utterance_ids": [utterance_id],
                }
            )

        async def flush(self):
            return None

    monkeypatch.setattr(transcript_processing, "TranscriptProcessor", _RecordingProcessor)

    result = await extract_graph_for_conversation(
        _FakeDb(conversation, [utterance]),
        conversation_id=str(conversation_id),
        owner_id="owner",
    )

    assert [provider["id"] for provider in observed["providers"]] == ["m5"]
    assert observed["llm_config"]["mode"] == "local"
    assert result["auditable_node_count"] == 1
    persist_graph.assert_awaited_once()
