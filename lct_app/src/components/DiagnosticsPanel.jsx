import { useState, useEffect } from "react";

import { getSttSettings } from "../services/sttSettingsApi";
import { STT_PROVIDER_OPTIONS, normalizeSttSettings } from "./audio/sttUtils";
import useSttTelemetry from "./audio/useSttTelemetry";

const formatMs = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "\u2014");

const formatClock = (isoValue) => {
  if (!isoValue) return "\u2014";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return "\u2014";
  return parsed.toLocaleTimeString();
};

export default function DiagnosticsPanel() {
  const [sttSettings, setSttSettings] = useState(null);
  const [sttForm, setSttForm] = useState(null);
  const [loading, setLoading] = useState(true);

  const { telemetry, loading: telemetryLoading, error: telemetryError, refresh: refreshTelemetry } =
    useSttTelemetry({ autoRefreshMs: 5000 });

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getSttSettings();
        const normalized = normalizeSttSettings(data);
        setSttSettings(normalized);
        setSttForm(normalized);
      } catch (err) {
        console.error("Unable to load STT settings for diagnostics:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Diagnostics</h2>
        <p className="text-sm text-gray-500">
          Live telemetry and debug info. This tab auto-refreshes.
        </p>
      </div>

      {/* STT Telemetry */}
      <div className="border border-blue-100 bg-blue-50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">STT Turnaround Telemetry</h3>
            <p className="text-xs text-blue-800">
              Live from recent transcript events (auto-refresh every 5s).
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshTelemetry({ silent: false })}
            className="text-xs px-3 py-1 border border-blue-300 rounded text-blue-700 hover:bg-blue-100"
          >
            {telemetryLoading ? "Refreshing..." : "Refresh"}
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
          Updated: {formatClock(telemetry?.generated_at)} · Window: {telemetry?.window_size || 0} events
        </p>
      </div>

      {/* Active connection info */}
      {!loading && sttForm && (
        <div className="text-xs text-gray-500 space-y-1 border border-gray-200 rounded p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Active Configuration</h3>
          <p>Retention: {sttSettings?.retention || "forever (default)"}.</p>
          <p>
            Active provider WS URL:{" "}
            <code className="bg-gray-100 px-1 rounded">
              {sttForm?.provider_urls?.[sttForm?.provider] || sttForm?.ws_url || "not configured"}
            </code>
          </p>
          <p>
            Active provider HTTP URL:{" "}
            <code className="bg-gray-100 px-1 rounded">
              {sttForm?.provider_http_urls?.[sttForm?.provider] || sttForm?.http_url || "not configured"}
            </code>
          </p>
          <p>
            Audio download token:{" "}
            <code className="bg-gray-100 px-1 rounded">
              {sttSettings?.download_token || "not configured"}
            </code>
          </p>
        </div>
      )}
    </section>
  );
}
