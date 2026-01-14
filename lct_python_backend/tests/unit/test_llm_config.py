from lct_python_backend.services.llm_config import get_env_llm_defaults, merge_llm_config


def test_env_llm_defaults(monkeypatch):
    monkeypatch.setenv("DEFAULT_LLM_MODE", "online")
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:1234")
    monkeypatch.setenv("LOCAL_LLM_CHAT_MODEL", "glm-4.6v-flash")
    monkeypatch.setenv("LOCAL_LLM_EMBEDDING_MODEL", "embed-model")
    monkeypatch.setenv("LOCAL_LLM_JSON_MODE", "false")
    monkeypatch.setenv("LOCAL_LLM_TIMEOUT_SECONDS", "45")

    defaults = get_env_llm_defaults()

    assert defaults["mode"] == "online"
    assert defaults["base_url"] == "http://localhost:1234"
    assert defaults["chat_model"] == "glm-4.6v-flash"
    assert defaults["embedding_model"] == "embed-model"
    assert defaults["json_mode"] is False
    assert defaults["timeout_seconds"] == 45.0


def test_merge_llm_config_sanitizes_mode(monkeypatch):
    monkeypatch.setenv("DEFAULT_LLM_MODE", "local")

    merged = merge_llm_config({"mode": "invalid", "json_mode": "0"})

    assert merged["mode"] == "local"
    assert merged["json_mode"] is False
