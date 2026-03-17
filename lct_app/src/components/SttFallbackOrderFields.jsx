import PropTypes from "prop-types";
import { ChevronDown, ChevronUp } from "lucide-react";

import { LIVE_FALLBACK_ROUTE_OPTIONS, normalizeProvider } from "./audio/sttUtils";

const ROUTE_COPY = {
  remote_whisper: {
    title: "Remote Whisper",
    description: "Use the configured Whisper HTTP endpoint after the primary live provider fails.",
  },
  external_http: {
    title: "External HTTP",
    description: "Use the generic external STT HTTP endpoint when local-only mode is off.",
  },
  openai_audio: {
    title: "OpenAI Audio",
    description: "Cloud diarized fallback for live sessions.",
  },
  openrouter_audio: {
    title: "OpenRouter Audio",
    description: "Degraded text-only cloud fallback.",
  },
};

function getRouteStatus(routeId, value) {
  const normalizedProvider = normalizeProvider(value?.provider);
  const cloudProviders = value?.cloud_fallback_providers || {};

  if (routeId === "remote_whisper") {
    if (value?.local_only) return { tone: "text-slate-500", label: "off in local-only mode" };
    if (normalizedProvider === "whisper") {
      return { tone: "text-slate-500", label: "skipped when Whisper is primary" };
    }
    return value?.provider_http_urls?.whisper
      ? { tone: "text-emerald-700", label: "configured" }
      : { tone: "text-amber-700", label: "needs Whisper HTTP URL" };
  }

  if (routeId === "external_http") {
    if (value?.local_only) return { tone: "text-slate-500", label: "off in local-only mode" };
    return value?.external_fallback_http_url
      ? { tone: "text-emerald-700", label: "configured" }
      : { tone: "text-amber-700", label: "needs external HTTP URL" };
  }

  if (routeId === "openai_audio") {
    const provider = cloudProviders.openai_audio || {};
    if (!value?.live_cloud_fallback_enabled) {
      return { tone: "text-slate-500", label: "cloud fallback disabled" };
    }
    return provider.enabled && provider.base_url && provider.model
      ? { tone: "text-emerald-700", label: "configured" }
      : { tone: "text-amber-700", label: "configure and enable provider" };
  }

  if (routeId === "openrouter_audio") {
    const provider = cloudProviders.openrouter_audio || {};
    if (!value?.live_cloud_fallback_enabled) {
      return { tone: "text-slate-500", label: "cloud fallback disabled" };
    }
    if (!provider.enabled || !provider.base_url || !provider.model) {
      return { tone: "text-amber-700", label: "configure and enable provider" };
    }
    if (value?.live_require_diarization && !value?.live_allow_text_only_fallback) {
      return { tone: "text-slate-500", label: "blocked by diarization requirement" };
    }
    return { tone: "text-amber-700", label: "configured (degraded)" };
  }

  return { tone: "text-slate-500", label: "unknown" };
}

export default function SttFallbackOrderFields({ onMove, value }) {
  const order = Array.isArray(value?.live_fallback_priority)
    ? value.live_fallback_priority
    : LIVE_FALLBACK_ROUTE_OPTIONS;

  return (
    <section className="border border-slate-200 bg-slate-50 rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Live Fallback Order</h3>
        <p className="text-xs text-slate-600">
          The primary STT provider always runs first. These routes are tried afterward in the order shown here.
        </p>
      </div>

      <div className="space-y-2">
        {order.map((routeId, index) => {
          const route = ROUTE_COPY[routeId];
          const status = getRouteStatus(routeId, value);
          return (
            <div
              key={routeId}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => onMove(index, -1)}
                  disabled={index === 0}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30"
                  title="Move up"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onMove(index, 1)}
                  disabled={index === order.length - 1}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30"
                  title="Move down"
                >
                  <ChevronDown size={14} />
                </button>
              </div>

              <span className="w-5 text-center text-xs font-medium text-slate-400">{index + 1}</span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-slate-900">{route?.title || routeId}</p>
                  <span className={`text-[11px] font-medium ${status.tone}`}>{status.label}</span>
                </div>
                <p className="text-xs text-slate-500">{route?.description || routeId}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

SttFallbackOrderFields.propTypes = {
  onMove: PropTypes.func.isRequired,
  value: PropTypes.object,
};
