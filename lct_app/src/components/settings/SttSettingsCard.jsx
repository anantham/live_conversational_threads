import { useMemo, useState } from "react";

import SttCloudFallbackFields from "../SttCloudFallbackFields";
import SttFallbackOrderFields from "../SttFallbackOrderFields";
import { formatProviderLabel } from "../audio/sttUtils";
import DisclosureSection from "./DisclosureSection";
import { buildSttSummary } from "./settingsSummary";
import SttDiagnosticsPanel from "./SttDiagnosticsPanel";
import SttEndpointFields from "./SttEndpointFields";
import useSttSettingsForm from "./useSttSettingsForm";

const buildCloudProvidersSummary = (form = {}) => {
  const providers = form?.cloud_fallback_providers || {};
  const enabledProviders = Object.values(providers).filter((provider) => provider?.enabled);
  if (!form?.live_cloud_fallback_enabled) {
    return "Cloud fallback disabled";
  }
  if (!enabledProviders.length) {
    return "No cloud providers enabled";
  }
  return enabledProviders.map((provider) => provider.name || provider.id).join(" + ");
};

export default function SttSettingsCard() {
  const {
    cloudProviderChecks,
    error,
    feedback,
    form,
    handleChange,
    handleCloudFallbackFlagChange,
    handleCloudProviderClearToggle,
    handleCloudProviderFieldChange,
    handleCloudProviderTest,
    handleFallbackPriorityMove,
    handleProviderHttpUrlChange,
    handleProviderUrlChange,
    handleSave,
    loading,
    reload,
    saving,
    settings,
  } = useSttSettingsForm();
  const [openSection, setOpenSection] = useState(null);

  const sttSummary = useMemo(() => buildSttSummary(form || settings || {}), [form, settings]);

  if (loading) {
    return (
      <div className="rounded-lg bg-white p-6 text-sm text-gray-500 shadow">
        Loading STT settings...
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-lg bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">Live transcription (STT)</h2>
          <p className="mt-1 text-sm text-gray-500">
            Fine-tune the speech-to-text engine you chose in <span className="font-medium">Active engines</span> above —
            its fallback order, endpoints, and cloud keys. Open the advanced sections only when you need them.
          </p>
          <p className="mt-2 text-xs text-gray-600">{sttSummary}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reload}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            type="button"
          >
            Reload
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white transition hover:bg-blue-700 disabled:opacity-60"
            disabled={saving}
            type="button"
          >
            {saving ? "Saving..." : "Save Live STT Settings"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {feedback ? (
        <p
          className={`rounded px-3 py-2 text-xs ${
            feedback.tone === "success"
              ? "border border-green-200 bg-green-50 text-green-700"
              : "border border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {feedback.message}
        </p>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-sm font-medium text-slate-900">
          Primary engine: {formatProviderLabel(form?.provider || "whisper")}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          This engine always runs first for live transcription. To change it, use{" "}
          <span className="font-medium">Active engines</span> at the top of this page. The fallback
          routes below only run after it fails or times out mid-session.
        </p>
      </section>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={Boolean(form?.store_audio)}
          onChange={handleChange("store_audio")}
          className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
        />
        <span>Record audio (save for later use)</span>
      </label>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-1 text-sm text-gray-700">
            <span className="block">Primary engine</span>
            <div className="flex items-center justify-between rounded border border-gray-200 bg-gray-50 px-3 py-2">
              <span className="font-medium text-gray-800">
                {formatProviderLabel(form?.provider || "whisper")}
              </span>
              <span className="text-xs text-gray-400">read-only</span>
            </div>
            <p className="text-xs text-gray-500">
              Change the engine in <span className="font-medium">Active engines ↑</span>
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.local_only)}
              onChange={handleChange("local_only")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Local-only (never send audio to the cloud)</span>
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.live_cloud_fallback_enabled)}
              onChange={handleCloudFallbackFlagChange("live_cloud_fallback_enabled")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Allow cloud fallback if local engines fail</span>
          </label>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              Local-only: {form?.local_only ? "on" : "off"}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              Cloud fallback: {form?.live_cloud_fallback_enabled ? "on" : "off"}
            </span>
          </div>
        </div>

        <SttFallbackOrderFields value={form} onMove={handleFallbackPriorityMove} />
      </div>

      <div className="space-y-3">
        <DisclosureSection
          title="Manage endpoints"
          description="Per-provider URLs, model hints, and upload endpoints."
          summary={`Primary HTTP: ${form?.provider_http_urls?.[form?.provider] || "not configured"}`}
          open={openSection === "endpoints"}
          onToggle={() =>
            setOpenSection((current) => (current === "endpoints" ? null : "endpoints"))
          }
        >
          <SttEndpointFields
            form={form}
            onChange={handleChange}
            onProviderHttpUrlChange={handleProviderHttpUrlChange}
            onProviderUrlChange={handleProviderUrlChange}
          />
        </DisclosureSection>

        <DisclosureSection
          title="Cloud providers"
          description="Configure provider credentials and degraded-mode rules."
          summary={buildCloudProvidersSummary(form)}
          open={openSection === "cloud"}
          onToggle={() => setOpenSection((current) => (current === "cloud" ? null : "cloud"))}
        >
          <SttCloudFallbackFields
            cloudProviderChecks={cloudProviderChecks}
            disabled={saving}
            value={form}
            onFlagChange={handleCloudFallbackFlagChange}
            onProviderFieldChange={handleCloudProviderFieldChange}
            onProviderClearToggle={handleCloudProviderClearToggle}
            onProviderTest={handleCloudProviderTest}
            showEnableToggle={false}
          />
        </DisclosureSection>

        <DisclosureSection
          title="Diagnostics"
          description="Telemetry, provider health, and debug metadata."
          summary="Telemetry and manual provider checks load only while this section is open."
          open={openSection === "diagnostics"}
          onToggle={() =>
            setOpenSection((current) => (current === "diagnostics" ? null : "diagnostics"))
          }
        >
          {openSection === "diagnostics" ? (
            <SttDiagnosticsPanel form={form} settings={settings} />
          ) : null}
        </DisclosureSection>
      </div>
    </section>
  );
}
