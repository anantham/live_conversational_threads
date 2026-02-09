import { useState, useEffect } from "react";

import {
  checkSttProviderHealth,
  getSttSettings,
  getSttTelemetry,
  updateSttSettings,
} from "../services/sttSettingsApi";
import {
  STT_PROVIDER_OPTIONS,
  normalizeProvider,
  normalizeSttSettings,
} from "./audio/sttUtils";

const formatMs = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "—");

const formatClock = (isoValue) => {
  if (!isoValue) return "—";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString();
};

export default function SttSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState(null);
  const [healthByProvider, setHealthByProvider] = useState({});

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
      setError("Unable to load STT configuration.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadTelemetry();
    const intervalId = setInterval(() => {
      loadTelemetry({ silent: true });
    }, 5000);
    return () => clearInterval(intervalId);
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
      setError("Unable to persist STT settings.");
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

  const loadTelemetry = async ({ silent = false } = {}) => {
    if (!silent) {
      setTelemetryLoading(true);
    }
    setTelemetryError(null);
    try {
      const data = await getSttTelemetry(500);
      setTelemetry(data);
    } catch (err) {
      console.error("Failed to load STT telemetry:", err);
      setTelemetryError("Unable to load STT telemetry.");
    } finally {
      if (!silent) {
        setTelemetryLoading(false);
      }
    }
  };

  const handleHealthCheck = async (providerId) => {
    const wsUrl = form?.provider_urls?.[providerId] || "";
    setHealthByProvider((prev) => ({
      ...prev,
      [providerId]: {
        ...(prev?.[providerId] || {}),
        checking: true,
        error: null,
      },
    }));
    try {
      const result = await checkSttProviderHealth({ provider: providerId, ws_url: wsUrl });
      setHealthByProvider((prev) => ({
        ...prev,
        [providerId]: {
          ...result,
          checking: false,
        },
      }));
    } catch (err) {
      const message = err?.message || "Health check failed.";
      setHealthByProvider((prev) => ({
        ...prev,
        [providerId]: {
          ...(prev?.[providerId] || {}),
          checking: false,
          ok: false,
          error: message,
          checked_at: new Date().toISOString(),
        },
      }));
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mt-6 text-sm text-gray-500">
        Loading STT settings…
      </div>
    );
  }

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">STT Settings</h2>
          <p className="text-sm text-gray-500">
            Local-first streaming with provider routing and telemetry metadata capture.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm text-blue-600 hover:text-blue-800"
          type="button"
        >
          {loading ? "Refreshing…" : "Reload"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
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
          <span>Chunk Endpoint</span>
          <input
            type="text"
            value={form?.chunk_endpoint || ""}
            onChange={handleChange("chunk_endpoint")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Finalize Endpoint</span>
          <input
            type="text"
            value={form?.complete_endpoint || ""}
            onChange={handleChange("complete_endpoint")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
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

      <div className="grid gap-4 md:grid-cols-2">
        {STT_PROVIDER_OPTIONS.map((providerId) => (
          <div key={providerId} className="text-sm text-gray-700 space-y-1 border border-gray-200 rounded p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{providerId} WS URL</span>
              <button
                type="button"
                onClick={() => handleHealthCheck(providerId)}
                disabled={Boolean(healthByProvider?.[providerId]?.checking)}
                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-60"
              >
                {healthByProvider?.[providerId]?.checking ? "Checking…" : "Health Check"}
              </button>
            </div>
            <input
              type="text"
              value={form?.provider_urls?.[providerId] || ""}
              onChange={handleProviderUrlChange(providerId)}
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

      <section className="border border-blue-100 bg-blue-50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">STT Turnaround Telemetry</h3>
            <p className="text-xs text-blue-800">
              Live from recent transcript events (auto-refresh every 5s).
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadTelemetry({ silent: false })}
            className="text-xs px-3 py-1 border border-blue-300 rounded text-blue-700 hover:bg-blue-100"
          >
            {telemetryLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {telemetryError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {telemetryError}
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {STT_PROVIDER_OPTIONS.map((providerId) => {
            const providerTelemetry = telemetry?.providers?.[providerId] || {};
            return (
              <div key={providerId} className="bg-white border border-blue-100 rounded p-3 text-xs text-gray-700">
                <p className="font-semibold text-gray-900 mb-1">{providerId}</p>
                <p>Last partial: {formatMs(providerTelemetry?.last_partial_ms)}</p>
                <p>Last final: {formatMs(providerTelemetry?.last_final_ms)}</p>
                <p>Avg partial: {formatMs(providerTelemetry?.avg_partial_ms)}</p>
                <p>Avg final: {formatMs(providerTelemetry?.avg_final_ms)}</p>
                <p>Samples (final): {providerTelemetry?.final_samples || 0}</p>
                <p>Last seen: {formatClock(providerTelemetry?.last_event_at)}</p>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-blue-800">
          Updated: {formatClock(telemetry?.generated_at)} • Window: {telemetry?.window_size || 0} events
        </p>
      </section>

      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <label className="flex items-center space-x-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.local_only)}
              onChange={handleChange("local_only")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Local-only mode (default)</span>
          </label>
          <label className="flex items-center space-x-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.store_audio)}
              onChange={handleChange("store_audio")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Store audio chunks (opt-in)</span>
          </label>
        </div>
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving}
          type="button"
        >
          {saving ? "Saving…" : "Save STT Settings"}
        </button>
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        <p>Retention: {settings?.retention || "forever (default)"}.</p>
        <p>
          Active provider URL: <code>{form?.provider_urls?.[form?.provider] || form?.ws_url || "not configured"}</code>
        </p>
        <p>
          Audio download token: <code>{settings?.download_token || "not configured"}</code>
        </p>
      </div>
    </section>
  );
}
