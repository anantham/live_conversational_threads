import PropTypes from "prop-types";

const CLOUD_PROVIDER_ORDER = ["openai_audio", "openrouter_audio"];

const PROVIDER_COPY = {
  openai_audio: {
    subtitle: "Best cloud fallback when speaker labels matter.",
  },
  openrouter_audio: {
    subtitle: "Degraded text-only fallback. No reliable diarization.",
  },
};

export default function SttCloudFallbackFields({
  value,
  onFlagChange,
  onProviderFieldChange,
  onProviderClearToggle,
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
          return (
            <div
              key={providerId}
              className="bg-white border border-amber-100 rounded p-4 space-y-3 text-sm text-gray-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-900">{provider.name || providerId}</p>
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
                <span className="text-xs text-gray-600">Model</span>
                <input
                  type="text"
                  value={provider.model || ""}
                  onChange={onProviderFieldChange(providerId, "model")}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                />
              </label>

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
  value: PropTypes.object,
  onFlagChange: PropTypes.func.isRequired,
  onProviderFieldChange: PropTypes.func.isRequired,
  onProviderClearToggle: PropTypes.func.isRequired,
  showEnableToggle: PropTypes.bool,
};
