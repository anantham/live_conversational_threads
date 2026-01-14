import { useEffect, useState } from "react";

import { getLlmSettings, updateLlmSettings } from "../services/llmSettingsApi";

const CHAT_MODELS = [
  "glm-4.6v-flash",
  "reka-flash-3-21b-reasoning-uncensored-max-neo-imatrix",
  "qwen/qwen3-coder-30b",
  "qwen/qwen3-vl-8b",
  "liquid/lfm2.5-1.2b",
];

const EMBEDDING_MODELS = [
  "text-embedding-qwen3-embedding-8b",
  "text-embedding-multilingual-e5-large-instruct",
  "text-embedding-nomic-embed-text-v1.5",
];

const CUSTOM_VALUE = "__custom__";

export default function LlmSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [chatChoice, setChatChoice] = useState(CUSTOM_VALUE);
  const [embeddingChoice, setEmbeddingChoice] = useState(CUSTOM_VALUE);
  const [customChatModel, setCustomChatModel] = useState("");
  const [customEmbeddingModel, setCustomEmbeddingModel] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLlmSettings();
      setSettings(data);
      setForm(data);

      const chatModel = data?.chat_model || "";
      if (CHAT_MODELS.includes(chatModel)) {
        setChatChoice(chatModel);
        setCustomChatModel("");
      } else {
        setChatChoice(CUSTOM_VALUE);
        setCustomChatModel(chatModel);
      }

      const embeddingModel = data?.embedding_model || "";
      if (EMBEDDING_MODELS.includes(embeddingModel)) {
        setEmbeddingChoice(embeddingModel);
        setCustomEmbeddingModel("");
      } else {
        setEmbeddingChoice(CUSTOM_VALUE);
        setCustomEmbeddingModel(embeddingModel);
      }
    } catch (err) {
      console.error("Unable to load LLM settings:", err);
      setError("Unable to load LLM configuration.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...form,
        chat_model: chatChoice === CUSTOM_VALUE ? customChatModel : chatChoice,
        embedding_model: embeddingChoice === CUSTOM_VALUE ? customEmbeddingModel : embeddingChoice,
      };
      const updated = await updateLlmSettings(payload);
      setSettings(updated);
      setForm(updated);
    } catch (err) {
      console.error("Failed to save LLM settings:", err);
      setError("Unable to persist LLM settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mt-6 text-sm text-gray-500">
        Loading LLM settings…
      </div>
    );
  }

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">LLM Settings</h2>
          <p className="text-sm text-gray-500">
            Local mode uses LM Studio. Online mode allows external providers if keys are configured.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm text-blue-600 hover:text-blue-800"
          type="button"
        >
          Reload
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm text-gray-700 space-y-1">
          <span>Mode</span>
          <select
            value={form?.mode || "local"}
            onChange={handleChange("mode")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          >
            <option value="local">Local (private)</option>
            <option value="online">Online (external)</option>
          </select>
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Local LLM Base URL</span>
          <input
            type="text"
            value={form?.base_url || ""}
            onChange={handleChange("base_url")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Chat Model</span>
          <select
            value={chatChoice}
            onChange={(event) => setChatChoice(event.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          >
            {CHAT_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value={CUSTOM_VALUE}>Custom…</option>
          </select>
          {chatChoice === CUSTOM_VALUE && (
            <input
              type="text"
              value={customChatModel}
              onChange={(event) => setCustomChatModel(event.target.value)}
              placeholder="Enter custom chat model id"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
          )}
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Embedding Model</span>
          <select
            value={embeddingChoice}
            onChange={(event) => setEmbeddingChoice(event.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          >
            {EMBEDDING_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value={CUSTOM_VALUE}>Custom…</option>
          </select>
          {embeddingChoice === CUSTOM_VALUE && (
            <input
              type="text"
              value={customEmbeddingModel}
              onChange={(event) => setCustomEmbeddingModel(event.target.value)}
              placeholder="Enter custom embedding model id"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
          )}
        </label>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          Default: {settings?.chat_model || "glm-4.6v-flash"} +{" "}
          {settings?.embedding_model || "text-embedding-qwen3-embedding-8b"}.
        </p>
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving}
          type="button"
        >
          {saving ? "Saving…" : "Save LLM Settings"}
        </button>
      </div>
    </section>
  );
}
