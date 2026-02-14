from lct_python_backend.services import transcript_processing as transcript_processing_module
from lct_python_backend.services.transcript_processing import _normalize_generated_output


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
        transcript_processing_module,
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
        transcript_processing_module,
        "accumulate_text_json_local",
        lambda input_text, **kwargs: {
            "decision": "continue_accumulating",
            "Completed_segment": "",
            "Incomplete_segment": input_text,
            "detected_threads": [],
        },
    )

    result = transcript_processing_module.accumulate_text_json(
        "hello there",
        llm_config={"mode": "online"},
    )

    warnings = result.get("_warnings", [])
    assert any("GEMINI_KEY" in warning for warning in warnings)


def test_resolve_online_gemini_model_uses_chat_model(monkeypatch):
    monkeypatch.setattr(transcript_processing_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "gemini-3-flash-preview"}
    )
    assert resolved == "gemini-3-flash-preview"


def test_resolve_online_gemini_model_normalizes_prefix(monkeypatch):
    monkeypatch.setattr(transcript_processing_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "models/gemini-2.0-flash"}
    )
    assert resolved == "gemini-2.0-flash"


def test_resolve_online_gemini_model_falls_back_for_local_model(monkeypatch):
    monkeypatch.setattr(transcript_processing_module, "GEMINI_MODEL_NAME", "gemini-2.5-flash")
    resolved = transcript_processing_module._resolve_online_gemini_model(
        {"mode": "online", "chat_model": "glm-4.6v-flash"}
    )
    assert resolved == "gemini-2.5-flash"


def test_generate_lct_json_online_passes_selected_gemini_model(monkeypatch):
    monkeypatch.setattr(transcript_processing_module, "_resolve_gemini_api_key", lambda: ("fake-key", "GEMINI_KEY"))
    captured = {}

    def _fake_generate(transcript, **kwargs):
        captured["model_name"] = kwargs.get("model_name")
        return [{"node_name": "gemini-node", "summary": "ok"}]

    monkeypatch.setattr(transcript_processing_module, "generate_lct_json_gemini", _fake_generate)

    result = transcript_processing_module.generate_lct_json(
        "Transcript text",
        llm_config={"mode": "online", "chat_model": "gemini-3-flash-preview"},
    )

    assert result[0]["node_name"] == "gemini-node"
    assert captured["model_name"] == "gemini-3-flash-preview"
