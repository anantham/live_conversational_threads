import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { ChevronUp, ChevronDown, Trash2, Plus, RefreshCw } from "lucide-react";

import { apiFetch } from "../services/apiClient";
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

const DEFAULT_PROVIDER = {
  id: "",
  name: "",
  type: "openai_compatible",
  base_url: "",
  model: "",
  api_key: "",
  enabled: true,
  timeout_seconds: 120,
};

/* ── Model Configuration (absorbed from LlmSettingsPanel) ─────────── */

function ModelConfigSection() {
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

  const hasForm = Boolean(form);
  const modelMode = form?.mode || "local";
  const modelBaseUrl = form?.base_url || "";

  useEffect(() => {
    if (!hasForm) return;
    let active = true;

    const loadModels = async () => {
      setChatModelsLoading(true);
      setChatModelsError(null);
      try {
        const options = await getLlmModelOptions({
          mode: modelMode,
          baseUrl: modelBaseUrl,
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
  }, [hasForm, modelMode, modelBaseUrl]);

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
    return <p className="text-sm text-gray-500 py-2">Loading model configuration...</p>;
  }

  return (
    <div className="space-y-3">
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
      </div>

      <details className="text-sm text-gray-700">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 py-1">
          Advanced: Base URL, Embedding Model
        </summary>
        <div className="grid gap-4 md:grid-cols-2 mt-2">
          <label className="space-y-1">
            <span>Local LLM Base URL</span>
            <input
              type="text"
              value={form?.base_url || ""}
              onChange={handleChange("base_url")}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="space-y-1">
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
              <option value={CUSTOM_VALUE}>Custom...</option>
            </select>
            {embeddingChoice === CUSTOM_VALUE && (
              <input
                type="text"
                value={customEmbeddingModel}
                onChange={(event) => setCustomEmbeddingModel(event.target.value)}
                placeholder="Enter custom embedding model id"
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 mt-1"
              />
            )}
          </label>
        </div>
      </details>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-gray-500">
          Current: {form?.chat_model || "n/a"} + {settings?.embedding_model || "text-embedding-qwen3-embedding-8b"}.
        </p>
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving || chatModelsLoading}
          type="button"
        >
          {saving ? "Saving..." : "Save Model Settings"}
        </button>
      </div>
    </div>
  );
}

/* ── Provider Row ─────────────────────────────────────────────────── */

function ProviderRow({ provider, index, total, onMove, onToggle, onDelete, onHealthCheck, healthStatus }) {
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <div className={`flex items-center gap-2 p-3 rounded-lg border ${
      provider.enabled ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"
    }`}>
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          disabled={isFirst}
          className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
          title="Move up (higher priority)"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          disabled={isLast}
          className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
          title="Move down (lower priority)"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <span className="w-6 text-center text-xs font-medium text-gray-400">
        {index + 1}
      </span>

      <input
        type="checkbox"
        checked={provider.enabled}
        onChange={() => onToggle(index)}
        className="w-4 h-4 rounded border-gray-300"
        title={provider.enabled ? "Disable provider" : "Enable provider"}
      />

      <span
        className={`w-2 h-2 rounded-full ${
          healthStatus?.healthy
            ? "bg-green-500"
            : healthStatus?.error
            ? "bg-red-500"
            : "bg-gray-300"
        }`}
        title={
          healthStatus?.healthy
            ? `Healthy (${healthStatus.latency_ms}ms)`
            : healthStatus?.error || "Not checked"
        }
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-gray-800 truncate">
            {provider.name || provider.id}
          </span>
          <span className="text-xs text-gray-400 px-1.5 py-0.5 bg-gray-100 rounded">
            {provider.type}
          </span>
        </div>
        <div className="text-xs text-gray-500 truncate">
          {provider.model} @ {provider.base_url}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onHealthCheck(index)}
        className="p-1.5 text-gray-400 hover:text-blue-600"
        title="Check health"
      >
        <RefreshCw size={14} />
      </button>
      <button
        type="button"
        onClick={() => onDelete(index)}
        className="p-1.5 text-gray-400 hover:text-red-600"
        title="Remove provider"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

ProviderRow.propTypes = {
  provider: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onMove: PropTypes.func.isRequired,
  onToggle: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onHealthCheck: PropTypes.func.isRequired,
  healthStatus: PropTypes.object,
};

/* ── Add Provider Form ────────────────────────────────────────────── */

function AddProviderForm({ onAdd, onCancel }) {
  const [form, setForm] = useState({ ...DEFAULT_PROVIDER, id: `provider_${Date.now()}` });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.base_url || !form.model) {
      return;
    }
    onAdd(form);
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-gray-700 space-y-1">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="My Provider"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            required
          />
        </label>
        <label className="text-xs text-gray-700 space-y-1">
          <span>Type</span>
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            <option value="openai_compatible">OpenAI Compatible</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
      </div>
      <label className="block text-xs text-gray-700 space-y-1">
        <span>Base URL</span>
        <input
          type="text"
          value={form.base_url}
          onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
          placeholder="https://api.example.com"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          required
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-gray-700 space-y-1">
          <span>Model</span>
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="qwen3-32b"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            required
          />
        </label>
        <label className="text-xs text-gray-700 space-y-1">
          <span>API Key (optional)</span>
          <input
            type="password"
            value={form.api_key}
            onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
            placeholder="sk-..."
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Add Provider
        </button>
      </div>
    </form>
  );
}

AddProviderForm.propTypes = {
  onAdd: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

/* ── Main Panel ───────────────────────────────────────────────────── */

export default function LlmProvidersPanel() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [healthStatuses, setHealthStatuses] = useState({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("/api/settings/llm/providers");
      if (!response.ok) throw new Error("Failed to load providers");
      const data = await response.json();
      setConfig(data);
    } catch (err) {
      console.error("Failed to load LLM providers:", err);
      setError("Unable to load provider configuration.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (newConfig) => {
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch("/api/settings/llm/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      if (!response.ok) throw new Error("Failed to save providers");
      const data = await response.json();
      setConfig(data);
    } catch (err) {
      console.error("Failed to save LLM providers:", err);
      setError("Unable to save provider configuration.");
    } finally {
      setSaving(false);
    }
  };

  const handleMove = (index, direction) => {
    const providers = [...config.providers];
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= providers.length) return;
    [providers[index], providers[newIndex]] = [providers[newIndex], providers[index]];
    const newConfig = { ...config, providers };
    setConfig(newConfig);
    save(newConfig);
  };

  const handleToggle = (index) => {
    const providers = [...config.providers];
    providers[index] = { ...providers[index], enabled: !providers[index].enabled };
    const newConfig = { ...config, providers };
    setConfig(newConfig);
    save(newConfig);
  };

  const handleDelete = (index) => {
    if (!window.confirm("Remove this provider?")) return;
    const providers = config.providers.filter((_, i) => i !== index);
    const newConfig = { ...config, providers };
    setConfig(newConfig);
    save(newConfig);
  };

  const handleAdd = (provider) => {
    const providers = [...config.providers, provider];
    const newConfig = { ...config, providers };
    setConfig(newConfig);
    save(newConfig);
    setShowAddForm(false);
  };

  const handleHealthCheck = async (index) => {
    const provider = config.providers[index];
    try {
      const response = await apiFetch("/api/settings/llm/providers/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: provider.base_url }),
      });
      const status = await response.json();
      setHealthStatuses((prev) => ({ ...prev, [provider.id]: status }));
    } catch (err) {
      setHealthStatuses((prev) => ({
        ...prev,
        [provider.id]: { healthy: false, error: err.message },
      }));
    }
  };

  const checkAllHealth = async () => {
    if (!config?.providers) return;
    for (let i = 0; i < config.providers.length; i++) {
      await handleHealthCheck(i);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mt-6 text-sm text-gray-500">
        Loading LLM configuration...
      </div>
    );
  }

  const providers = config?.providers || [];

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-6">
      {/* Model Configuration — high-frequency settings */}
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-1">Model Configuration</h2>
        <p className="text-sm text-gray-500 mb-3">
          Local mode uses LM Studio. Online mode uses Gemini with accepted model IDs only.
        </p>
        <ModelConfigSection />
      </div>

      <hr className="border-gray-200" />

      {/* Provider Priority List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Provider Priority</h2>
            <p className="text-sm text-gray-500">
              Providers are tried in order. First enabled + healthy provider wins.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={checkAllHealth}
              className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
              type="button"
            >
              <RefreshCw size={14} />
              Check All
            </button>
            <button
              onClick={load}
              className="text-sm text-gray-500 hover:text-gray-700"
              type="button"
            >
              Reload
            </button>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="space-y-2">
          {providers.map((provider, index) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              index={index}
              total={providers.length}
              onMove={handleMove}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onHealthCheck={handleHealthCheck}
              healthStatus={healthStatuses[provider.id]}
            />
          ))}

          {providers.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-8">
              No providers configured. Add one to get started.
            </div>
          )}
        </div>

        {showAddForm ? (
          <AddProviderForm onAdd={handleAdd} onCancel={() => setShowAddForm(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800"
          >
            <Plus size={16} />
            Add Provider
          </button>
        )}

        {saving && (
          <p className="text-xs text-gray-400">Saving...</p>
        )}
      </div>
    </section>
  );
}
