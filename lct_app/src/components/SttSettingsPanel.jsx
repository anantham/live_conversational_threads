import { useState, useEffect } from "react";

import { getSttSettings, updateSttSettings } from "../services/sttSettingsApi";
import {
  STT_PROVIDER_OPTIONS,
  normalizeProvider,
  normalizeSttSettings,
} from "./audio/sttUtils";
import useProviderHealthChecks from "./audio/useProviderHealthChecks";

const formatMs = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "\u2014");

const formatClock = (isoValue) => {
  if (!isoValue) return "\u2014";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return "\u2014";
  return parsed.toLocaleTimeString();
};

export default function SttSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const { healthByProvider, checkHealth } = useProviderHealthChecks();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSttSettings();
      const normalized = normalizeSttSettings(data);
      setSettings(normalized);
      setForm(normalized);
    } catch (err) {
      console.error("Unable to load STT settings:", err);
      const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
      setError(isNetworkError ? "Backend unavailable" : "Unable to load STT configuration.");
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
      const normalized = normalizeSttSettings(form);
      const payload = {
        ...normalized,
        ws_url: normalized.provider_urls?.[normalized.provider] || normalized.ws_url,
      };
      const updated = await updateSttSettings(payload);
      const updatedNormalized = normalizeSttSettings(updated);
      setSettings(updatedNormalized);
      setForm(updatedNormalized);
    } catch (err) {
      console.error("Failed to save STT settings:", err);
      const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
      setError(isNetworkError ? "Backend unavailable" : "Unable to persist STT settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => {
      const next = { ...(prev || {}), [key]: value };
      if (key === "provider") {
        const normalizedProvider = normalizeProvider(value);
        next.provider = normalizedProvider;
        next.ws_url = next.provider_urls?.[normalizedProvider] || "";
        next.http_url = next.provider_http_urls?.[normalizedProvider] || "";
      }
      return next;
    });
  };

  const handleProviderUrlChange = (providerId) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...(prev || {}),
      provider_urls: {
        ...(prev?.provider_urls || {}),
        [providerId]: value,
      },
      ws_url:
        normalizeProvider(prev?.provider) === providerId
          ? value
          : prev?.ws_url || "",
    }));
  };

  const handleProviderHttpUrlChange = (providerId) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...(prev || {}),
      provider_http_urls: {
        ...(prev?.provider_http_urls || {}),
        [providerId]: value,
      },
      http_url:
        normalizeProvider(prev?.provider) === providerId
          ? value
          : prev?.http_url || "",
    }));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mt-6 text-sm text-gray-500">
        Loading STT settings...
      </div>
    );
  }

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Speech-to-Text</h2>
          <p className="text-sm text-gray-500">
            Provider, model, and routing configuration.
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

      {/* Primary controls — what you actually change */}
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm text-gray-700 space-y-1">
          <span>STT Provider</span>
          <select
            value={form?.provider || "whisper"}
            onChange={handleChange("provider")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          >
            {STT_PROVIDER_OPTIONS.map((providerId) => (
              <option key={providerId} value={providerId}>
                {providerId}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Model override</span>
          <input
            type="text"
            value={form?.http_model || ""}
            onChange={handleChange("http_model")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. large-v3, whisper-1 (blank = server default)"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Language hint</span>
          <input
            type="text"
            value={form?.http_language || ""}
            onChange={handleChange("http_language")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. en, hi (blank = auto-detect)"
          />
        </label>
      </div>

      {/* Policy toggles — promoted for visibility */}
      <div className="flex items-center gap-6">
        <label className="flex items-center space-x-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.local_only)}
            onChange={handleChange("local_only")}
            className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Local-only mode</span>
        </label>
        <label className="flex items-center space-x-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.store_audio)}
            onChange={handleChange("store_audio")}
            className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Store audio chunks</span>
        </label>
      </div>

      {/* Endpoints — rarely changed */}
      <details className="text-sm text-gray-700">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 py-1">
          Endpoints: chunk, finalize, fallback
        </summary>
        <div className="grid gap-4 md:grid-cols-2 mt-2">
          <label className="space-y-1">
            <span>Chunk Endpoint</span>
            <input
              type="text"
              value={form?.chunk_endpoint || ""}
              onChange={handleChange("chunk_endpoint")}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="space-y-1">
            <span>Finalize Endpoint</span>
            <input
              type="text"
              value={form?.complete_endpoint || ""}
              onChange={handleChange("complete_endpoint")}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span>External Fallback WS URL</span>
            <input
              type="text"
              value={form?.external_fallback_ws_url || ""}
              onChange={handleChange("external_fallback_ws_url")}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
              placeholder="Optional. Used only when local-only is disabled."
            />
          </label>
        </div>
      </details>

      {/* Per-provider URLs — infrastructure plumbing */}
      <details className="text-sm text-gray-700">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 py-1">
          Per-provider URLs and health checks
        </summary>
        <div className="grid gap-4 md:grid-cols-2 mt-2">
          {STT_PROVIDER_OPTIONS.map((providerId) => (
            <div key={providerId} className="space-y-1 border border-gray-200 rounded p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{providerId}</span>
                <button
                  type="button"
                  onClick={() =>
                    checkHealth(
                      providerId,
                      form?.provider_urls?.[providerId] || "",
                      form?.provider_http_urls?.[providerId] || ""
                    )
                  }
                  disabled={Boolean(healthByProvider?.[providerId]?.checking)}
                  className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-60"
                >
                  {healthByProvider?.[providerId]?.checking ? "Checking..." : "Health Check"}
                </button>
              </div>
              <label className="block text-xs text-gray-600">WS URL</label>
              <input
                type="text"
                value={form?.provider_urls?.[providerId] || ""}
                onChange={handleProviderUrlChange(providerId)}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
              />
              <label className="block text-xs text-gray-600 mt-1">HTTP Transcription URL</label>
              <input
                type="text"
                value={form?.provider_http_urls?.[providerId] || ""}
                onChange={handleProviderHttpUrlChange(providerId)}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500">
                {healthByProvider?.[providerId]?.checked_at ? (
                  healthByProvider?.[providerId]?.ok ? (
                    <>
                      Healthy ({healthByProvider?.[providerId]?.status_code || "200"}) in{" "}
                      {formatMs(healthByProvider?.[providerId]?.latency_ms)} at{" "}
                      {formatClock(healthByProvider?.[providerId]?.checked_at)}
                    </>
                  ) : (
                    <>
                      Unhealthy: {healthByProvider?.[providerId]?.error || "check failed"}{" "}
                      ({formatClock(healthByProvider?.[providerId]?.checked_at)})
                    </>
                  )
                ) : (
                  "No health check run yet."
                )}
              </p>
            </div>
          ))}
        </div>
      </details>

      {/* Save */}
      <div className="flex items-center justify-end pt-2">
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving}
          type="button"
        >
          {saving ? "Saving..." : "Save STT Settings"}
        </button>
      </div>
    </section>
  );
}
