import json

from lct_python_backend.services.prompt_manager import PromptManager
from lct_python_backend.services import transcript_llm_callers as llm_callers_module
from lct_python_backend.services import import_graph_refinement as refinement_module
from lct_python_backend.services import transcript_prompts as prompt_module


def test_prompt_manager_renders_brace_and_dollar_placeholders(tmp_path):
    prompts_file = tmp_path / "prompts.json"
    prompts_file.write_text(json.dumps({"prompts": {}}), encoding="utf-8")

    manager = PromptManager(prompts_file=str(prompts_file), history_dir=str(tmp_path / "history"))
    rendered = manager.render_prompt_string(
        "Hello {name}, meet $other.",
        {"name": "Ada", "other": "Grace"},
        prompt_name="compat_test",
    )

    assert rendered == "Hello Ada, meet Grace."


def test_prompt_manager_validation_accepts_provider_specific_model_ids(tmp_path):
    prompts_file = tmp_path / "prompts.json"
    prompts_file.write_text(json.dumps({"prompts": {}}), encoding="utf-8")

    manager = PromptManager(prompts_file=str(prompts_file), history_dir=str(tmp_path / "history"))
    validation = manager.validate_prompt(
        {
            "description": "test",
            "template": "hello",
            "model": "claude-3-5-sonnet-20241022",
        }
    )

    assert validation["valid"] is True
    assert validation["errors"] == []


def test_get_transcript_prompt_text_prefers_prompt_manager(monkeypatch):
    class _FakePromptManager:
        def get_prompt(self, prompt_name):
            assert prompt_name == prompt_module.PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT
            return {"template": "managed prompt"}

        def render_prompt_string(self, template, variables, prompt_name="<inline>"):
            return template

    monkeypatch.setattr(prompt_module, "get_prompt_manager", lambda: _FakePromptManager())

    prompt_text = prompt_module.get_transcript_prompt_text(
        prompt_module.PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT
    )

    assert prompt_text == "managed prompt"


def test_generate_lct_json_local_uses_managed_prompt(monkeypatch):
    captured = {}

    class _FakeProviderResult:
        def backend_label(self):
            return "local_test"

    monkeypatch.setattr(
        llm_callers_module,
        "get_transcript_prompt_text",
        lambda prompt_id, variables=None: "managed local hierarchy prompt",
    )
    monkeypatch.setattr(
        llm_callers_module,
        "get_transcript_prompt_metadata",
        lambda prompt_id: {"temperature": 0.12, "max_tokens": 321},
    )

    def _fake_call(prompt, system_prompt, providers, temperature, max_tokens):
        captured["system_prompt"] = system_prompt
        captured["temperature"] = temperature
        captured["max_tokens"] = max_tokens
        return [{"node_name": "Node A", "summary": "Summary A"}], _FakeProviderResult()

    monkeypatch.setattr(llm_callers_module, "_call_local_chat_json_with_fallback", _fake_call)

    nodes, backend_label = llm_callers_module.generate_lct_json_local(
        "hello there",
        providers=[],
        retries=1,
    )

    assert backend_label == "local_test"
    assert nodes[0]["node_name"] == "Node A"
    assert captured["system_prompt"] == "managed local hierarchy prompt"
    assert captured["temperature"] == 0.12
    assert captured["max_tokens"] == 321


def test_refine_graph_nodes_local_uses_managed_prompt(monkeypatch):
    captured = {}

    class _FakeProviderResult:
        def backend_label(self):
            return "local_refine"

    monkeypatch.setattr(
        refinement_module,
        "get_transcript_prompt_text",
        lambda prompt_id, variables=None: "managed refinement prompt",
    )
    monkeypatch.setattr(
        refinement_module,
        "get_transcript_prompt_metadata",
        lambda prompt_id: {"temperature": 0.23, "max_tokens": 654},
    )

    def _fake_call(prompt, system_prompt, providers, temperature, max_tokens):
        captured["system_prompt"] = system_prompt
        captured["temperature"] = temperature
        captured["max_tokens"] = max_tokens
        return [{"node_name": "Node A", "summary": "Summary A"}], _FakeProviderResult()

    monkeypatch.setattr(refinement_module, "_call_local_chat_json_with_fallback", _fake_call)

    nodes, backend_label, error = refinement_module._refine_graph_nodes_local(
        "refine this",
        providers=[],
    )

    assert error is None
    assert backend_label == "local_refine"
    assert nodes[0]["node_name"] == "Node A"
    assert captured["system_prompt"] == "managed refinement prompt"
    assert captured["temperature"] == 0.23
    assert captured["max_tokens"] == 654
