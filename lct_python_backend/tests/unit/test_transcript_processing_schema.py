from lct_python_backend.services import transcript_processing as transcript_processing_module
from lct_python_backend.services import transcript_llm_callers as llm_callers_module
from lct_python_backend.services.transcript_processing import (
    _normalize_generated_output,
    format_speaker_prefixed_transcript,
)


def test_normalize_generated_output_accepts_nodes_and_edges_object():
    parsed = {
        "nodes": [
            {
                "id": "n1",
                "node_name": "Launch Timeline",
                "summary": "Discussed Friday ship date.",
                "thread_id": "thread-launch",
                "thread_state": "new_thread",
            },
            {
                "id": "n2",
                "node_name": "Landlord Repairs",
                "summary": "Discussed repair confirmation.",
                "thread_id": "thread-landlord",
                "thread_state": "new_thread",
            },
        ],
        "edges": [
            {
                "source": "n1",
                "target": "n2",
                "relation_type": "tangent",
                "relation_text": "Conversation branched from launch to landlord issue.",
            }
        ],
    }

    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 2

    landlord = next(node for node in normalized if node["node_name"] == "Landlord Repairs")
    assert landlord["contextual_relation"]["Launch Timeline"].startswith("Conversation branched")
    assert landlord["edge_relations"][0]["related_node"] == "Launch Timeline"
    assert landlord["edge_relations"][0]["relation_type"] == "tangent"


def test_normalize_generated_output_adds_required_defaults():
    parsed = {
        "node_name": "Scope Reduction",
        "summary": "Suggested shipping login and payments first.",
        "predecessor": "Launch Timeline",
    }

    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 1
    node = normalized[0]
    assert node["node_name"] == "Scope Reduction"
    assert node["thread_state"] == "continue_thread"
    assert isinstance(node["id"], str) and node["id"]
    assert node["node_text"] == node["summary"]
    assert node["semantic_level"] == 2
    assert node["semantic_type"] == "idea"


def test_normalize_generated_output_coerces_single_contextual_relation_object():
    parsed = [
        {
            "node_name": "A",
            "summary": "Root topic",
        },
        {
            "node_name": "B",
            "summary": "Follow-up topic",
            "contextual_relation": {
                "related_node_name": "A",
                "relation_text": "Builds on A",
            },
        },
    ]

    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 2
    node_b = next(node for node in normalized if node["node_name"] == "B")
    assert node_b["contextual_relation"] == {"A": "Builds on A"}
    assert "A" in node_b["linked_nodes"]
    assert any(
        relation["related_node"] == "A" and relation["relation_text"] == "Builds on A"
        for relation in node_b["edge_relations"]
    )


def test_resolve_gemini_api_key_accepts_gemini_key_alias(monkeypatch):
    monkeypatch.delenv("GOOGLEAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_KEY", "gemini-key-alias")

    key, source = transcript_processing_module._resolve_gemini_api_key()

    assert key == "gemini-key-alias"
    assert source == "GEMINI_KEY"


def test_generate_lct_json_online_missing_key_emits_fallback_warning(monkeypatch):
    monkeypatch.delenv("GOOGLEAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_KEY", raising=False)

    monkeypatch.setattr(
        llm_callers_module,
        "generate_lct_json_local",
        lambda *args, **kwargs: [{"node_name": "fallback-node", "summary": "from-local"}],
    )

    messages = []
    result = transcript_processing_module.generate_lct_json(
        "Transcript text",
        llm_config={"mode": "online"},
        status_messages=messages,
    )

    assert result[0]["node_name"] == "fallback-node"
    assert any("GEMINI_KEY" in message for message in messages)


def test_accumulate_text_json_online_missing_key_adds_warning(monkeypatch):
    monkeypatch.delenv("GOOGLEAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_KEY", raising=False)

    monkeypatch.setattr(
        llm_callers_module,
        "accumulate_text_json_local",
        lambda input_text, **kwargs: (
            {
                "decision": "continue_accumulating",
                "Completed_segment": "",
                "Incomplete_segment": input_text,
                "detected_threads": [],
            },
            "local_fallback",
        ),
    )

    result, _ = transcript_processing_module.accumulate_text_json(
        "hello there",
        llm_config={"mode": "online"},
    )

    warnings = result.get("_warnings", [])
    assert any("GEMINI_KEY" in warning for warning in warnings)


def test_resolve_online_gemini_model_uses_chat_model(monkeypatch):
    monkeypatch.setattr(llm_callers_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "gemini-3-flash-preview"}
    )
    assert resolved == "gemini-3-flash-preview"


def test_resolve_online_gemini_model_normalizes_prefix(monkeypatch):
    monkeypatch.setattr(llm_callers_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "models/gemini-2.0-flash"}
    )
    assert resolved == "gemini-2.0-flash"


def test_resolve_online_gemini_model_falls_back_for_local_model(monkeypatch):
    monkeypatch.setattr(llm_callers_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "glm-4.6v-flash"}
    )
    assert resolved == "gemini-2.5-flash"


def test_generate_lct_json_online_passes_selected_gemini_model(monkeypatch):
    monkeypatch.setattr(llm_callers_module, "_resolve_gemini_api_key", lambda: ("fake-key", "GEMINI_KEY"))
    captured = {}

    def _fake_generate(transcript, **kwargs):
        captured["model_name"] = kwargs.get("model_name")
        return [{"node_name": "gemini-node", "summary": "ok"}]

    monkeypatch.setattr(llm_callers_module, "generate_lct_json_gemini", _fake_generate)

    result, _ = transcript_processing_module.generate_lct_json(
        "Transcript text",
        llm_config={"mode": "online", "chat_model": "gemini-3-flash-preview"},
    )

    assert result[0]["node_name"] == "gemini-node"
    assert captured["model_name"] == "gemini-3-flash-preview"


# ---------------------------------------------------------------------------
# Speaker diarization tests
# ---------------------------------------------------------------------------
def test_format_speaker_prefixed_transcript_with_segments():
    segments = [
        {"speaker": "SPEAKER_00", "text": "Hello there.", "start": 0.0, "end": 1.5},
        {"speaker": "SPEAKER_01", "text": "Hi, how are you.", "start": 2.0, "end": 4.0},
    ]
    result = format_speaker_prefixed_transcript("Hello there. Hi, how are you.", segments)
    assert "[SPEAKER_00]: Hello there." in result
    assert "[SPEAKER_01]: Hi, how are you." in result
    assert result == "[SPEAKER_00]: Hello there.\n[SPEAKER_01]: Hi, how are you."


def test_format_speaker_prefixed_transcript_without_segments():
    result = format_speaker_prefixed_transcript("plain text", None)
    assert result == "plain text"


def test_format_speaker_prefixed_transcript_empty_segments():
    result = format_speaker_prefixed_transcript("plain text", [])
    assert result == "plain text"


def test_format_speaker_prefixed_transcript_skips_empty_text():
    segments = [
        {"speaker": "SPEAKER_00", "text": "Hello", "start": 0.0, "end": 1.0},
        {"speaker": "SPEAKER_01", "text": "", "start": 1.0, "end": 2.0},
        {"speaker": "SPEAKER_02", "text": "World", "start": 2.0, "end": 3.0},
    ]
    result = format_speaker_prefixed_transcript("Hello World", segments)
    assert "[SPEAKER_00]: Hello" in result
    assert "[SPEAKER_02]: World" in result
    assert "SPEAKER_01" not in result


def test_normalize_generated_output_preserves_speaker_id():
    parsed = [
        {
            "node_name": "Greeting",
            "summary": "Initial greeting exchange",
            "speaker_id": "SPEAKER_00",
        },
        {
            "node_name": "Question",
            "summary": "Asked about project",
            "speaker_id": "SPEAKER_01",
            "predecessor": "Greeting",
        },
    ]
    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 2
    assert normalized[0]["speaker_id"] == "SPEAKER_00"
    assert normalized[1]["speaker_id"] == "SPEAKER_01"


def test_normalize_generated_output_speaker_id_null_when_missing():
    parsed = [
        {
            "node_name": "No Speaker",
            "summary": "No speaker info",
        },
    ]
    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 1
    assert normalized[0]["speaker_id"] is None


def test_normalize_generated_output_preserves_authored_hierarchy_fields():
    parsed = {
        "nodes": [
            {
                "id": "chunk-1",
                "node_name": "Need clearer defaults",
                "summary": "They argue the defaults are confusing.",
                "semantic_level": 1,
                "semantic_type": "chunk",
                "parent_id": "idea-1",
                "successor": "chunk-2",
                "speaker_id": "SPEAKER_00",
            },
            {
                "id": "idea-1",
                "node_name": "Config confusion",
                "summary": "A full idea about settings confusion and what to rename.",
                "semantic_level": 2,
                "semantic_type": "idea",
                "children_ids": ["chunk-1", "chunk-2"],
                "thread_id": "thread-config",
                "thread_state": "new_thread",
            },
        ]
    }

    normalized = _normalize_generated_output(parsed)
    assert len(normalized) == 2

    chunk = next(node for node in normalized if node["id"] == "chunk-1")
    idea = next(node for node in normalized if node["id"] == "idea-1")

    assert chunk["semantic_level"] == 1
    assert chunk["semantic_type"] == "chunk"
    assert chunk["parent_id"] == "idea-1"
    assert idea["children_ids"] == ["chunk-1", "chunk-2"]
    assert idea["node_type"] == "idea"


def test_split_segments_for_completed_chunk_separates_carryover():
    text_batch = ["A done", "B later"]
    segment_batch = [
        [{"speaker": "SPEAKER_00", "text": "A done"}],
        [{"speaker": "SPEAKER_01", "text": "B later"}],
    ]

    completed, carryover = (
        transcript_processing_module.TranscriptProcessor._split_segments_for_completed_chunk(
            text_batch=text_batch,
            segment_batch=segment_batch,
            completed_text="A done",
            incomplete_text="B later",
            stop_accumulating_flag=False,
        )
    )

    assert [segment["text"] for segment in completed] == ["A done"]
    assert len(carryover) == 1
    assert [segment["text"] for segment in carryover[0]] == ["B later"]


def test_split_segments_for_completed_chunk_uses_all_segments_on_forced_flush():
    text_batch = ["A done", "B later"]
    segment_batch = [
        [{"speaker": "SPEAKER_00", "text": "A done"}],
        [{"speaker": "SPEAKER_01", "text": "B later"}],
    ]

    completed, carryover = (
        transcript_processing_module.TranscriptProcessor._split_segments_for_completed_chunk(
            text_batch=text_batch,
            segment_batch=segment_batch,
            completed_text="A done B later",
            incomplete_text="",
            stop_accumulating_flag=True,
        )
    )

    assert [segment["text"] for segment in completed] == ["A done", "B later"]
    assert carryover == []


def test_propagate_flags_upward_chunk_to_arc():
    from lct_python_backend.services.transcript_normalizer import propagate_flags_upward

    # chunk(tangent) -> idea -> topic ; chunk(crux) -> idea -> topic
    nodes = [
        {"id": "c1", "semantic_level": 1, "is_tangent": True, "children_ids": []},
        {"id": "c2", "semantic_level": 1, "is_crux": True, "children_ids": []},
        {"id": "c3", "semantic_level": 1, "children_ids": []},
        {"id": "i1", "semantic_level": 2, "children_ids": ["c1", "c3"]},
        {"id": "i2", "semantic_level": 2, "children_ids": ["c2"]},
        {"id": "t1", "semantic_level": 3, "children_ids": ["i1", "i2"]},
    ]
    propagate_flags_upward(nodes)
    by_id = {n["id"]: n for n in nodes}

    # idea inherits its chunks' flags
    assert by_id["i1"].get("is_tangent") is True
    assert not by_id["i1"].get("is_crux")
    assert by_id["i2"].get("is_crux") is True
    # topic inherits transitively from both ideas
    assert by_id["t1"].get("is_tangent") is True
    assert by_id["t1"].get("is_crux") is True
    # a leaf with no flagged children is untouched
    assert not by_id["c3"].get("is_tangent")


def test_surprise_propagates_but_action_item_does_not():
    from lct_python_backend.services.transcript_normalizer import propagate_flags_upward

    # chunk carries both; surprise should roll up, action_item should NOT
    # (a topic that *contains* a commitment is not itself an action item).
    nodes = [
        {"id": "c1", "semantic_level": 1, "is_action_item": True, "is_surprise": True, "children_ids": []},
        {"id": "i1", "semantic_level": 2, "children_ids": ["c1"]},
        {"id": "t1", "semantic_level": 3, "children_ids": ["i1"]},
    ]
    propagate_flags_upward(nodes)
    by_id = {n["id"]: n for n in nodes}

    assert by_id["i1"].get("is_surprise") is True
    assert by_id["t1"].get("is_surprise") is True
    assert not by_id["i1"].get("is_action_item")
    assert not by_id["t1"].get("is_action_item")
