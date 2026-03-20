import PropTypes from "prop-types";

import { STT_PROVIDER_OPTIONS } from "../audio/sttUtils";
import useProviderHealthChecks from "../audio/useProviderHealthChecks";
import useSttTelemetry from "../audio/useSttTelemetry";

const formatMs = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "—");

const formatClock = (isoValue) => {
  if (!isoValue) return "—";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString();
};

export default function SttDiagnosticsPanel({ form, settings }) {
  const {
    telemetry,
    loading: telemetryLoading,
    error: telemetryError,
    refresh: refreshTelemetry,
  } = useSttTelemetry({ autoRefreshMs: 5000 });
  const { healthByProvider, checkHealth } = useProviderHealthChecks();

  const checkAllProviders = async () => {
    for (const providerId of STT_PROVIDER_OPTIONS) {
      await checkHealth(
        providerId,
        form?.provider_urls?.[providerId] || "",
        form?.provider_http_urls?.[providerId] || "",
      );
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-blue-100 bg-blue-50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">STT Turnaround Telemetry</h3>
            <p className="text-xs text-blue-800">
              Live from recent transcript events while this section is open.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshTelemetry({ silent: false })}
            className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100"
          >
            {telemetryLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {telemetryError ? (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {telemetryError}
          </p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          {STT_PROVIDER_OPTIONS.map((providerId) => {
            const providerTelemetry = telemetry?.providers?.[providerId] || {};
            return (
              <div
                key={providerId}
                className="rounded border border-blue-100 bg-white p-3 text-xs text-gray-700"
              >
                <p className="mb-1 font-semibold text-gray-900">{providerId}</p>
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

      <section className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Provider Health Checks</h3>
            <p className="text-xs text-gray-500">
              Manual probes against the currently configured provider URLs.
            </p>
          </div>
          <button
            type="button"
            onClick={checkAllProviders}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100"
          >
            Check All
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {STT_PROVIDER_OPTIONS.map((providerId) => {
            const health = healthByProvider?.[providerId];
            return (
              <div
                key={providerId}
                className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-700"
              >
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-semibold text-gray-900">{providerId}</p>
                  <button
                    type="button"
                    onClick={() =>
                      checkHealth(
                        providerId,
                        form?.provider_urls?.[providerId] || "",
                        form?.provider_http_urls?.[providerId] || "",
                      )
                    }
                    disabled={Boolean(health?.checking)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-60"
                  >
                    {health?.checking ? "Checking..." : "Check"}
                  </button>
                </div>
                <p>WS URL: {form?.provider_urls?.[providerId] || "not configured"}</p>
                <p>HTTP URL: {form?.provider_http_urls?.[providerId] || "not configured"}</p>
                <p className="mt-2 text-gray-500">
                  {health?.checked_at ? (
                    health?.ok ? (
                      <>
                        Healthy ({health?.status_code || "200"}) in {formatMs(health?.latency_ms)} at{" "}
                        {formatClock(health?.checked_at)}
                      </>
                    ) : (
                      <>
                        Unhealthy: {health?.error || "check failed"} ({formatClock(health?.checked_at)})
                      </>
                    )
                  ) : (
                    "No health check run yet."
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 text-xs text-gray-500">
        <p>Retention: {settings?.retention || "forever (default)"}.</p>
        <p>
          Active provider WS URL:{" "}
          <code>{form?.provider_urls?.[form?.provider] || form?.ws_url || "not configured"}</code>
        </p>
        <p>
          Active provider HTTP URL:{" "}
          <code>{form?.provider_http_urls?.[form?.provider] || form?.http_url || "not configured"}</code>
        </p>
        <p>
          Audio download token: <code>{settings?.has_download_token ? "configured" : "not configured"}</code>
        </p>
      </section>
    </div>
  );
}

SttDiagnosticsPanel.propTypes = {
  form: PropTypes.object,
  settings: PropTypes.object,
};
