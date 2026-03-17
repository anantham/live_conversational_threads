import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { ChevronUp, ChevronDown, Trash2, Plus, RefreshCw } from "lucide-react";

import { apiFetch } from "../services/apiClient";

const PROVIDER_TYPE_OPTIONS = [
  {
    value: "openai_compatible",
    label: "OpenAI Compatible",
    defaultBaseUrl: "",
    modelPlaceholder: "qwen3-32b",
  },
  {
    value: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com",
    modelPlaceholder: "gpt-4.1-mini",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api",
    modelPlaceholder: "google/gemini-2.5-flash",
  },
];

const PROVIDER_TYPE_LABELS = Object.fromEntries(
  PROVIDER_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

const DEFAULT_PROVIDER = {
  id: "",
  name: "",
  type: "openai_compatible",
  base_url: "",
  model: "",
  api_key: "",
  enabled: true,
  timeout_seconds: 120,
  has_api_key: false,
};

function getProviderTypeOption(providerType) {
  return (
    PROVIDER_TYPE_OPTIONS.find((option) => option.value === providerType) ||
    PROVIDER_TYPE_OPTIONS[0]
  );
}

function buildProviderDraft(provider) {
  return {
    ...DEFAULT_PROVIDER,
    ...provider,
    api_key: "",
    has_api_key: Boolean(provider?.has_api_key),
  };
}

function ProviderRow({
  provider,
  index,
  total,
  onMove,
  onToggle,
  onEdit,
  onDelete,
  onHealthCheck,
  healthStatus,
}) {
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <div
      className={`flex items-center gap-2 p-3 rounded-lg border ${
        provider.enabled ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"
      }`}
    >
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

      <span className="w-6 text-center text-xs font-medium text-gray-400">{index + 1}</span>

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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-gray-800 truncate">
            {provider.name || provider.id}
          </span>
          <span className="text-xs text-gray-400 px-1.5 py-0.5 bg-gray-100 rounded">
            {PROVIDER_TYPE_LABELS[provider.type] || provider.type}
          </span>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              provider.has_api_key ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
            }`}
          >
            {provider.has_api_key ? "key saved" : "no key"}
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
        onClick={() => onEdit(index)}
        className="px-2 py-1 text-xs text-gray-500 hover:text-blue-700"
        title="Edit provider"
      >
        Edit
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
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onHealthCheck: PropTypes.func.isRequired,
  healthStatus: PropTypes.object,
};

function ProviderForm({ initialProvider, mode, onSubmit, onCancel }) {
  const [form, setForm] = useState(() => buildProviderDraft(initialProvider));
  const [clearStoredKey, setClearStoredKey] = useState(false);

  const typeOption = getProviderTypeOption(form.type);
  const buttonLabel = mode === "edit" ? "Save Provider" : "Add Provider";

  useEffect(() => {
    setForm(buildProviderDraft(initialProvider));
    setClearStoredKey(false);
  }, [initialProvider]);

  const handleFieldChange = (key) => (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleTypeChange = (event) => {
    const nextType = event.target.value;
    const previousOption = getProviderTypeOption(form.type);
    const nextOption = getProviderTypeOption(nextType);
    const shouldUpdateBaseUrl =
      !String(form.base_url || "").trim() ||
      String(form.base_url || "").trim() === previousOption.defaultBaseUrl;

    setForm((current) => ({
      ...current,
      type: nextType,
      base_url: shouldUpdateBaseUrl ? nextOption.defaultBaseUrl : current.base_url,
    }));
  };

  const handleApiKeyChange = (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, api_key: value }));
    if (value.trim()) {
      setClearStoredKey(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.name || !form.base_url || !form.model) {
      return;
    }

    const payload = {
      ...form,
      id: String(form.id || `provider_${Date.now()}`).trim(),
      name: String(form.name || "").trim(),
      base_url: String(form.base_url || "").trim(),
      model: String(form.model || "").trim(),
      timeout_seconds: Number(form.timeout_seconds || 120),
      enabled: Boolean(form.enabled),
    };

    delete payload.has_api_key;
    if (clearStoredKey) {
      payload.clear_api_key = true;
      delete payload.api_key;
    } else if (!String(payload.api_key || "").trim()) {
      delete payload.api_key;
    }

    onSubmit(payload);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-blue-900">
          {mode === "edit" ? "Edit Provider" : "Add Provider"}
        </h3>
        {mode === "edit" && (
          <span className="text-xs text-blue-800">
            {form.id}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-gray-700 space-y-1">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            onChange={handleFieldChange("name")}
            placeholder="My Provider"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            required
          />
        </label>
        <label className="text-xs text-gray-700 space-y-1">
          <span>Type</span>
          <select
            value={form.type}
            onChange={handleTypeChange}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            {PROVIDER_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-xs text-gray-700 space-y-1">
        <span>Base URL</span>
        <input
          type="text"
          value={form.base_url}
          onChange={handleFieldChange("base_url")}
          placeholder={typeOption.defaultBaseUrl || "https://api.example.com"}
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
            onChange={handleFieldChange("model")}
            placeholder={typeOption.modelPlaceholder}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            required
          />
        </label>
        <label className="text-xs text-gray-700 space-y-1">
          <span>Timeout (seconds)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={form.timeout_seconds}
            onChange={handleFieldChange("timeout_seconds")}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </label>
      </div>

      <label className="block text-xs text-gray-700 space-y-1">
        <span>API Key</span>
        <input
          type="password"
          value={form.api_key}
          onChange={handleApiKeyChange}
          placeholder={mode === "edit" ? "Leave blank to keep current key" : "sk-..."}
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
        />
      </label>

      {mode === "edit" && (
        <div className="text-xs text-gray-600 space-y-2">
          <p>
            {form.has_api_key
              ? "A key is already stored on the backend. Leave this field blank to keep it, or enter a new key to replace it."
              : "No key is currently stored for this provider."}
          </p>
          {form.has_api_key && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={clearStoredKey}
                onChange={(event) => setClearStoredKey(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span>Clear stored API key on save</span>
            </label>
          )}
        </div>
      )}

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
          {buttonLabel}
        </button>
      </div>
    </form>
  );
}

ProviderForm.propTypes = {
  initialProvider: PropTypes.object.isRequired,
  mode: PropTypes.oneOf(["add", "edit"]).isRequired,
  onSubmit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

export default function LlmProvidersPanel({ embedded = false, onSaved }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
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
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || "Failed to save providers");
      }
      const data = await response.json();
      setConfig(data);
      onSaved?.(data);
      return data;
    } catch (err) {
      console.error("Failed to save LLM providers:", err);
      setError("Unable to save provider configuration.");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async (index, direction) => {
    const providers = [...(config?.providers || [])];
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= providers.length) return;
    [providers[index], providers[newIndex]] = [providers[newIndex], providers[index]];
    await save({ ...config, providers });
  };

  const handleToggle = async (index) => {
    const providers = [...(config?.providers || [])];
    providers[index] = { ...providers[index], enabled: !providers[index].enabled };
    await save({ ...config, providers });
  };

  const handleDelete = async (index) => {
    if (!window.confirm("Remove this provider?")) return;
    const providers = (config?.providers || []).filter((_, i) => i !== index);
    await save({ ...config, providers });
    if (editor?.mode === "edit") {
      if (editor.index === index) {
        setEditor(null);
      } else if (editor.index > index) {
        setEditor({ mode: "edit", index: editor.index - 1 });
      }
    }
  };

  const handleAdd = async (provider) => {
    const providers = [...(config?.providers || []), provider];
    await save({ ...config, providers });
    setEditor(null);
  };

  const handleUpdate = async (provider) => {
    if (editor?.mode !== "edit") return;
    const providers = [...(config?.providers || [])];
    providers[editor.index] = provider;
    await save({ ...config, providers });
    setEditor(null);
  };

  const handleHealthCheck = async (index) => {
    const provider = config?.providers?.[index];
    if (!provider) return;
    try {
      const response = await apiFetch("/api/settings/llm/providers/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
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
    for (let i = 0; i < config.providers.length; i += 1) {
      await handleHealthCheck(i);
    }
  };

  if (loading) {
    return (
      <div className={embedded ? "text-sm text-gray-500" : "bg-white rounded-lg shadow p-6 text-sm text-gray-500"}>
        Loading provider configuration...
      </div>
    );
  }

  const providers = config?.providers || [];
  const editingProvider =
    editor?.mode === "edit" ? providers[editor.index] || DEFAULT_PROVIDER : DEFAULT_PROVIDER;

  const content = (
    <div className="space-y-4">
      {!embedded ? (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Graph LLM Routing</h2>
            <p className="text-sm text-gray-500">
              Providers are tried top-to-bottom when graph updates need a model. API keys stay
              server-side; blank password fields keep the existing key.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={checkAllHealth}
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
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
      ) : (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={checkAllHealth}
            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
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
      )}

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
            onEdit={(providerIndex) => setEditor({ mode: "edit", index: providerIndex })}
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

      {editor?.mode === "edit" && (
        <ProviderForm
          mode="edit"
          initialProvider={editingProvider}
          onSubmit={handleUpdate}
          onCancel={() => setEditor(null)}
        />
      )}

      {editor?.mode === "add" ? (
        <ProviderForm
          mode="add"
          initialProvider={{ ...DEFAULT_PROVIDER, id: editor.draftId }}
          onSubmit={handleAdd}
          onCancel={() => setEditor(null)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditor({ mode: "add", draftId: `provider_${Date.now()}` })}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800"
        >
          <Plus size={16} />
          Add Provider
        </button>
      )}

      {saving && <p className="text-xs text-gray-400">Saving...</p>}
    </div>
  );

  if (embedded) {
    return content;
  }

  return <section className="bg-white rounded-lg shadow-lg p-6 space-y-4">{content}</section>;
}

LlmProvidersPanel.propTypes = {
  embedded: PropTypes.bool,
  onSaved: PropTypes.func,
};
