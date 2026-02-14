import { useEffect, useState } from "react";

import {
  getLlmModelOptions,
  getLlmSettings,
  updateLlmSettings,
} from "../services/llmSettingsApi";

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
  const [chatModels, setChatModels] = useState([]);
  const [chatModelsSource, setChatModelsSource] = useState("unknown");
  const [chatModelsLoading, setChatModelsLoading] = useState(false);
  const [chatModelsError, setChatModelsError] = useState(null);
  const [embeddingChoice, setEmbeddingChoice] = useState(CUSTOM_VALUE);
  const [customEmbeddingModel, setCustomEmbeddingModel] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLlmSettings();
      setSettings(data);
      setForm(data);

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

  useEffect(() => {
    if (!form) return;
    let active = true;

    const loadModels = async () => {
      setChatModelsLoading(true);
      setChatModelsError(null);
      try {
        const options = await getLlmModelOptions({
          mode: form.mode || "local",
          baseUrl: form.base_url || "",
        });
        if (!active) return;
        const models = Array.isArray(options?.models) ? options.models : [];
        setChatModels(models);
        setChatModelsSource(options?.source || "unknown");

        if (models.length > 0) {
          setForm((prev) => {
            if (!prev) return prev;
            const current = String(prev.chat_model || "").trim();
            if (models.includes(current)) return prev;
            return { ...prev, chat_model: models[0] };
          });
        }
      } catch (err) {
        console.error("Unable to load chat model options:", err);
        if (!active) return;
        setChatModels([]);
        setChatModelsSource("error");
        setChatModelsError("Unable to load accepted chat model options.");
      } finally {
        if (active) setChatModelsLoading(false);
      }
    };

    loadModels();

    return () => {
      active = false;
    };
  }, [form, form?.mode, form?.base_url]);

  const handleSave = async () => {
    if (!form) return;
    if (!String(form?.chat_model || "").trim()) {
      setError("Select an accepted chat model before saving.");
      return;
    }
    if ((form?.mode || "local") === "online") {
      const proceed = window.confirm(
        "Online mode sends transcript-derived data to external providers. Continue saving?"
      );
      if (!proceed) return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...form,
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
            Local mode uses LM Studio. Online mode uses Gemini with accepted model IDs only.
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
            <option value="online">Online (Gemini)</option>
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
            value={form?.chat_model || ""}
            onChange={handleChange("chat_model")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            disabled={chatModelsLoading}
          >
            {!chatModels.length && (
              <option value="">
                {chatModelsLoading ? "Loading accepted models..." : "No accepted models available"}
              </option>
            )}
            {chatModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">
            Source: {chatModelsSource}. Online mode is restricted to accepted Gemini models.
          </p>
          {chatModelsError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
              {chatModelsError}
            </p>
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
          Current: {form?.chat_model || "n/a"} + {settings?.embedding_model || "text-embedding-qwen3-embedding-8b"}.
        </p>
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving || chatModelsLoading}
          type="button"
        >
          {saving ? "Saving…" : "Save LLM Settings"}
        </button>
      </div>
    </section>
  );
}
