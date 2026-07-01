import { useMemo, useState } from "react";

import SttCloudFallbackFields from "../SttCloudFallbackFields";
import { formatProviderLabel, LIVE_FALLBACK_ROUTE_OPTIONS } from "../audio/sttUtils";
import DisclosureSection from "./DisclosureSection";
import RankedEngineList from "./RankedEngineList";
import { buildSttSummary } from "./settingsSummary";
import SttDiagnosticsPanel from "./SttDiagnosticsPanel";
import SttEndpointFields from "./SttEndpointFields";
import useSttSettingsForm from "./useSttSettingsForm";

// Friendly labels for the live fallback ROUTES (a different vocabulary from the
// primary engine — see ADR-061). Option A keeps the route model in the backend
// and WS contract; this only changes how STT is presented in Settings.
const ROUTE_LABELS = {
  remote_whisper: { name: "Remote Whisper", meta: "backend HTTP · diarizes" },
  external_http: { name: "External HTTP", meta: "generic endpoint · text-only" },
  openai_audio: { name: "OpenAI Audio", meta: "cloud · diarizes" },
  openrouter_audio: { name: "OpenRouter Audio", meta: "cloud · text-only" },
};

// A fallback route only actually runs when its config exists (mirrors the
// backend's candidate-build checks in stt_live_provider_selection.py). Grey a
// route with the reason when it can't serve, so the list doesn't imply a route
// will run when it won't.
function routeEligibility(rid, form) {
  const provider = String(form?.provider || "").toLowerCase();
  const httpUrls = form?.provider_http_urls || {};
  const cloud = form?.cloud_fallback_providers || {};
  const cloudOn = Boolean(form?.live_cloud_fallback_enabled);
  if (rid === "remote_whisper") {
    if (provider === "whisper") return { disabled: true, reason: "skipped while Whisper is primary" };
    return httpUrls.whisper
      ? { disabled: false }
      : { disabled: true, reason: "needs a Whisper HTTP URL (Manage endpoints)" };
  }
  if (rid === "external_http") {
    return form?.external_fallback_http_url
      ? { disabled: false }
      : { disabled: true, reason: "needs an External HTTP URL" };
  }
  if (rid === "openai_audio" || rid === "openrouter_audio") {
    if (!cloudOn) return { disabled: true, reason: "enable cloud fallback below" };
    const p = cloud[rid] || {};
    return p.enabled && p.base_url && p.model
      ? { disabled: false }
      : { disabled: true, reason: `configure & enable ${ROUTE_LABELS[rid].name}` };
  }
  return { disabled: false };
}

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

  // Primary engine options: whatever the form already knows about, so this stays
  // data-driven without a catalog round-trip.
  const engineOptions = useMemo(() => {
    const ids = new Set();
    if (form?.provider) ids.add(String(form.provider));
    Object.keys(form?.provider_http_urls || {}).forEach((k) => ids.add(k));
    Object.keys(form?.provider_urls || {}).forEach((k) => ids.add(k));
    return [...ids].filter(Boolean);
  }, [form]);

  // Fallback ROUTES as a unified ranked list (pure reorder — no primary among
  // them; the primary is the engine dropdown above). Cloud routes grey out when
  // cloud fallback is off. Writes back the existing live_fallback_priority field.
  const routeItems = useMemo(() => {
    const order =
      Array.isArray(form?.live_fallback_priority) && form.live_fallback_priority.length
        ? form.live_fallback_priority
        : LIVE_FALLBACK_ROUTE_OPTIONS;
    return order.map((rid) => {
      const info = ROUTE_LABELS[rid] || { name: rid, meta: "" };
      const { disabled, reason } = routeEligibility(rid, form);
      return {
        id: rid,
        name: info.name,
        meta: info.meta,
        status: disabled ? "idle" : "ok",
        disabled,
        disabledReason: disabled ? reason : undefined,
      };
    });
  }, [form]);

  const handleRouteReorder = (order) =>
    handleChange("live_fallback_priority")({ target: { value: order } });

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

      {/* Live order (Option A, ADR-061): the primary engine and its fallback routes
          presented as one top-to-bottom flow. Writes the existing provider +
          live_fallback_priority fields; backend / WS contract are untouched. */}
      <section className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Live order</h3>
          <p className="text-xs text-slate-600">
            Runs top to bottom: the primary engine first, then these fallback routes if it fails or
            times out mid-session. Endpoints resolve on the backend host (your M5), not this browser.
          </p>
        </div>

        <label className="block text-sm text-slate-800">
          <span className="mb-1 block text-xs font-medium text-slate-600">
            Primary engine — runs first
          </span>
          <select
            value={form?.provider || "whisper"}
            onChange={handleChange("provider")}
            className="w-full max-w-xs rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          >
            {engineOptions.map((id) => (
              <option key={id} value={id}>
                {formatProviderLabel(id)}
              </option>
            ))}
          </select>
        </label>

        {form?.local_only ? (
          <p className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500">
            Local-only is on, so no cloud fallback routes run. Turn it off below to enable fallback.
          </p>
        ) : (
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              If the primary fails, fall back to — drag to reorder
            </span>
            <RankedEngineList items={routeItems} onReorder={handleRouteReorder} showPrimary={false} />
          </div>
        )}
      </section>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.store_audio)}
            onChange={handleChange("store_audio")}
            className="h-4 w-4 rounded accent-gray-900"
          />
          <span>Record audio (save for later use)</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.local_only)}
            onChange={handleChange("local_only")}
            className="h-4 w-4 rounded accent-gray-900"
          />
          <span>Local-only (never send audio to the cloud)</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.live_cloud_fallback_enabled)}
            onChange={handleCloudFallbackFlagChange("live_cloud_fallback_enabled")}
            className="h-4 w-4 rounded accent-gray-900"
          />
          <span>Allow cloud fallback if local engines fail</span>
        </label>
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
