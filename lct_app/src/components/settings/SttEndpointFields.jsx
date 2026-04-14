import PropTypes from "prop-types";

import { STT_PROVIDER_OPTIONS } from "../audio/sttUtils";

const STT_LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
];

export default function SttEndpointFields({
  form,
  onChange,
  onProviderHttpUrlChange,
  onProviderUrlChange,
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm text-gray-700">
          <span>Model override</span>
          <input
            type="text"
            value={form?.http_model || ""}
            onChange={onChange("http_model")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. large-v3, whisper-1 (blank = server default)"
          />
        </label>

        <label className="space-y-1 text-sm text-gray-700">
          <span>Language hint</span>
          <select
            value={form?.http_language || ""}
            onChange={onChange("http_language")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
          >
            {STT_LANGUAGE_OPTIONS.map((option) => (
              <option key={`${option.value || "auto"}-${option.label}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">
            Default is English for live and upload STT requests.
          </p>
        </label>

        <label className="space-y-1 text-sm text-gray-700">
          <span>Chunk Endpoint</span>
          <input
            type="text"
            value={form?.chunk_endpoint || ""}
            onChange={onChange("chunk_endpoint")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="space-y-1 text-sm text-gray-700">
          <span>Finalize Endpoint</span>
          <input
            type="text"
            value={form?.complete_endpoint || ""}
            onChange={onChange("complete_endpoint")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="space-y-1 text-sm text-gray-700">
          <span>External Fallback WS URL</span>
          <input
            type="text"
            value={form?.external_fallback_ws_url || ""}
            onChange={onChange("external_fallback_ws_url")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            placeholder="Optional. Used only when local-only is disabled."
          />
        </label>

        <label className="space-y-1 text-sm text-gray-700">
          <span>External Fallback HTTP URL</span>
          <input
            type="text"
            value={form?.external_fallback_http_url || ""}
            onChange={onChange("external_fallback_http_url")}
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            placeholder="Optional. Used only when local-only is disabled."
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {STT_PROVIDER_OPTIONS.map((providerId) => (
          <div
            key={providerId}
            className="space-y-2 rounded border border-gray-200 p-3 text-sm text-gray-700"
          >
            <p className="font-medium text-gray-900">{providerId}</p>
            <label className="block space-y-1">
              <span className="text-xs text-gray-600">WS URL</span>
              <input
                type="text"
                value={form?.provider_urls?.[providerId] || ""}
                onChange={onProviderUrlChange(providerId)}
                className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-gray-600">HTTP Transcription URL</span>
              <input
                type="text"
                value={form?.provider_http_urls?.[providerId] || ""}
                onChange={onProviderHttpUrlChange(providerId)}
                className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
              />
            </label>
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={Boolean(form?.store_audio)}
          onChange={onChange("store_audio")}
          className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
        />
        <span>Store audio chunks (opt-in)</span>
      </label>
    </div>
  );
}

SttEndpointFields.propTypes = {
  form: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  onProviderHttpUrlChange: PropTypes.func.isRequired,
  onProviderUrlChange: PropTypes.func.isRequired,
};
