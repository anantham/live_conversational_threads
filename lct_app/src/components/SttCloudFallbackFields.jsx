import PropTypes from "prop-types";

const CLOUD_PROVIDER_ORDER = ["openai_audio", "openrouter_audio"];

const PROVIDER_COPY = {
  openai_audio: {
    subtitle: "Fast live captions first. Speaker-aware refinement runs separately.",
  },
  openrouter_audio: {
    subtitle: "Degraded text-only fallback. No reliable diarization.",
  },
};

const STATUS_BADGE_STYLES = {
  no_key: "bg-gray-100 text-gray-600 border border-gray-200",
  saved: "bg-blue-50 text-blue-700 border border-blue-200",
  testing: "bg-amber-50 text-amber-800 border border-amber-200",
  ready: "bg-green-50 text-green-700 border border-green-200",
  auth_failed: "bg-red-50 text-red-700 border border-red-200",
  quota_exceeded: "bg-red-50 text-red-700 border border-red-200",
  rate_limited: "bg-amber-50 text-amber-800 border border-amber-200",
  timeout: "bg-amber-50 text-amber-800 border border-amber-200",
  network_error: "bg-red-50 text-red-700 border border-red-200",
  misconfigured: "bg-amber-50 text-amber-800 border border-amber-200",
  bad_request: "bg-amber-50 text-amber-800 border border-amber-200",
  not_found: "bg-red-50 text-red-700 border border-red-200",
  provider_error: "bg-red-50 text-red-700 border border-red-200",
};

const STATUS_LABELS = {
  no_key: "No key",
  saved: "Saved",
  testing: "Testing",
  ready: "Ready",
  auth_failed: "Auth failed",
  quota_exceeded: "Quota issue",
  rate_limited: "Rate limited",
  timeout: "Timed out",
  network_error: "Network error",
  misconfigured: "Needs setup",
  bad_request: "Bad request",
  not_found: "Endpoint missing",
  provider_error: "Provider error",
};

const formatCheckedAt = (isoValue) => {
  if (!isoValue) return null;
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const formatLatency = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : null);

function getProviderStatus(provider, check) {
  if (check?.checking || check?.status === "testing") {
    return "testing";
  }
  if (check?.status) {
    return check.status;
  }
  if (provider?.has_api_key) {
    return "saved";
  }
  return "no_key";
}

export default function SttCloudFallbackFields({
  cloudProviderChecks,
  disabled = false,
  value,
  onFlagChange,
  onProviderFieldChange,
  onProviderClearToggle,
  onProviderTest,
  showEnableToggle = true,
}) {
  const providers = value?.cloud_fallback_providers || {};

  return (
    <section className="border border-amber-100 bg-amber-50 rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-amber-900">Cloud Fallback Providers</h3>
        <p className="text-xs text-amber-800">
          These providers participate only after the primary live route fails. Their relative order
          is controlled separately in the live fallback list.
        </p>
      </div>

      <div className={`grid gap-3 ${showEnableToggle ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {showEnableToggle ? (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(value?.live_cloud_fallback_enabled)}
              onChange={onFlagChange("live_cloud_fallback_enabled")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Enable cloud fallback</span>
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(value?.live_require_diarization)}
            onChange={onFlagChange("live_require_diarization")}
            className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Require diarization when possible</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(value?.live_allow_text_only_fallback)}
            onChange={onFlagChange("live_allow_text_only_fallback")}
            className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Allow degraded text-only fallback</span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {CLOUD_PROVIDER_ORDER.map((providerId) => {
          const provider = providers?.[providerId] || {};
          const copy = PROVIDER_COPY[providerId] || {};
          const check = cloudProviderChecks?.[providerId];
          const status = getProviderStatus(provider, check);
          const checkedAt = formatCheckedAt(check?.checked_at);
          const latency = formatLatency(check?.latency_ms);
          return (
            <div
              key={providerId}
              className="bg-white border border-amber-100 rounded p-4 space-y-3 text-sm text-gray-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-gray-900">{provider.name || providerId}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE_STYLES[status] || STATUS_BADGE_STYLES.provider_error}`}
                    >
                      {STATUS_LABELS[status] || "Unknown"}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{copy.subtitle}</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={Boolean(provider.enabled)}
                    onChange={onProviderFieldChange(providerId, "enabled", "checkbox")}
                    className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
                  />
                  <span>Enabled</span>
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-xs text-gray-600">Base URL</span>
                <input
                  type="text"
                  value={provider.base_url || ""}
                  onChange={onProviderFieldChange(providerId, "base_url")}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs text-gray-600">
                  {providerId === "openai_audio" ? "Live caption model" : "Model"}
                </span>
                <input
                  type="text"
                  value={provider.model || ""}
                  onChange={onProviderFieldChange(providerId, "model")}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                />
              </label>

              {providerId === "openai_audio" && (
                <label className="block space-y-1">
                  <span className="text-xs text-gray-600">Diarization model</span>
                  <input
                    type="text"
                    value={provider.diarize_model || ""}
                    onChange={onProviderFieldChange(providerId, "diarize_model")}
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  />
                </label>
              )}

              <label className="block space-y-1">
                <span className="text-xs text-gray-600">API Key</span>
                <input
                  type="password"
                  value={provider.api_key || ""}
                  onChange={onProviderFieldChange(providerId, "api_key")}
                  placeholder={provider.has_api_key ? "Leave blank to keep current key" : "sk-..."}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                />
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <div className="space-y-1">
                  <p>
                    {check?.status === "ready"
                      ? `${provider.name || providerId} responded${latency ? ` in ${latency}` : ""}.`
                      : check?.error
                      ? check.error
                      : provider.has_api_key
                      ? "Stored key present. Run Save & Test to verify auth and response time."
                      : "No stored key yet."}
                  </p>
                  {(check?.warning || check?.transcript_preview || checkedAt) && (
                    <p className="text-[11px] text-gray-500">
                      {check?.warning || check?.transcript_preview || ""}
                      {checkedAt ? `${check?.warning || check?.transcript_preview ? " " : ""}Last checked ${checkedAt}.` : ""}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onProviderTest(providerId)}
                  disabled={disabled || Boolean(check?.checking)}
                  className="rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {check?.checking ? "Testing..." : "Save & Test"}
                </button>
              </div>

              <div className="space-y-2 text-xs text-gray-600">
                <p>
                  {provider.has_api_key
                    ? "A key is already stored on the backend. Leave the password field blank to keep it."
                    : "No key stored yet."}
                </p>
                {provider.has_api_key && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(provider.clear_api_key)}
                      onChange={onProviderClearToggle(providerId)}
                      className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span>Clear stored key on save</span>
                  </label>
                )}
                {provider.degraded && (
                  <p className="text-amber-700">
                    This fallback is degraded: transcript text only, no reliable speaker labels.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

SttCloudFallbackFields.propTypes = {
  cloudProviderChecks: PropTypes.object,
  disabled: PropTypes.bool,
  value: PropTypes.object,
  onFlagChange: PropTypes.func.isRequired,
  onProviderFieldChange: PropTypes.func.isRequired,
  onProviderClearToggle: PropTypes.func.isRequired,
  onProviderTest: PropTypes.func.isRequired,
  showEnableToggle: PropTypes.bool,
};
