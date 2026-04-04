import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiFetch } from "../services/apiClient";

const POLL_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 3000;

const PILL_STYLES = {
  loading: {
    dot: "bg-slate-400",
    pill: "border-slate-200 bg-white/80 text-slate-500",
  },
  healthy: {
    dot: "bg-emerald-500",
    pill: "border-emerald-200 bg-emerald-50/90 text-emerald-700",
  },
  configured: {
    dot: "bg-amber-500",
    pill: "border-amber-200 bg-amber-50/90 text-amber-700",
  },
  unavailable: {
    dot: "bg-rose-500",
    pill: "border-rose-200 bg-rose-50/90 text-rose-700",
  },
};

function toTitleCase(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeError(error) {
  if (!error) {
    return "Not checked yet";
  }
  if (error.name === "AbortError") {
    return `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  const message = String(error.message || error).trim();
  return message || "Unavailable";
}

async function fetchJson(path) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function StatusPill({ details, label, state, summary }) {
  const styles = PILL_STYLES[state] || PILL_STYLES.loading;

  return (
    <div className="group relative">
      <button
        type="button"
        className={`inline-flex cursor-help items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-sm transition ${styles.pill}`}
        title={`${label}: ${summary}`}
        aria-label={`${label}: ${summary}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
        <span>{label}</span>
      </button>

      <div className="pointer-events-none absolute bottom-full left-0 z-20 mb-3 w-[min(22rem,calc(100vw-3rem))] translate-y-2 rounded-2xl border border-slate-200 bg-white/95 p-3 text-left opacity-0 shadow-xl backdrop-blur transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <p className="text-[11px] font-semibold text-slate-800">{summary}</p>
        <div className="mt-2 space-y-1.5">
          {details.map((detail) => (
            <div key={`${label}-${detail.label}`} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="text-slate-500">{detail.label}</span>
              <span className="max-w-[12rem] text-right font-medium text-slate-700">
                {detail.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

StatusPill.propTypes = {
  details: PropTypes.arrayOf(PropTypes.shape({
    label: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired,
  })).isRequired,
  label: PropTypes.string.isRequired,
  state: PropTypes.oneOf(["configured", "healthy", "loading", "unavailable"]).isRequired,
  summary: PropTypes.string.isRequired,
};

function buildLlmSignal(importStatus, llmSettings, probeError) {
  const llmProbe = importStatus?.services?.llm;
  const mode = llmSettings?.mode || "local";
  const model = llmSettings?.chat_model || "Not set";
  const homeProbe =
    llmProbe && llmProbe.healthy
      ? llmProbe.latency_ms
        ? `Healthy in ${llmProbe.latency_ms} ms`
        : "Healthy"
      : llmProbe?.error || probeError || "Not verified on home";

  if (mode === "online") {
    return {
      details: [
        { label: "Mode", value: "Online" },
        { label: "Model", value: model },
        { label: "Home probe", value: "Legacy import check" },
        { label: "Result", value: homeProbe },
      ],
      state: "configured",
      summary: "Online LLM is configured. Home still uses the older import probe.",
    };
  }

  if (llmProbe?.healthy) {
    return {
      details: [
        { label: "Mode", value: "Local" },
        { label: "Model", value: llmProbe.model || model },
        { label: "Endpoint", value: llmProbe.url || "Configured backend" },
        { label: "Latency", value: llmProbe.latency_ms ? `${llmProbe.latency_ms} ms` : "Healthy" },
      ],
      state: "healthy",
      summary: "Local LLM backend responded to the home probe.",
    };
  }

  return {
    details: [
      { label: "Mode", value: toTitleCase(mode) || "Unknown" },
      { label: "Model", value: model },
      { label: "Home probe", value: homeProbe },
      { label: "Meaning", value: "This chip is checking the older import health path." },
    ],
    state: llmSettings ? "configured" : "unavailable",
    summary: llmSettings
      ? "LLM is configured, but the home probe did not verify it."
      : "LLM settings are unavailable.",
  };
}

function buildSttSignal(importStatus, sttSettings, probeError) {
  const whisperx = importStatus?.services?.whisperx;
  const modalWhisperx = importStatus?.services?.modal_whisperx;
  const activeProbe = whisperx?.healthy ? whisperx : modalWhisperx?.healthy ? modalWhisperx : whisperx;
  const providerName = toTitleCase(sttSettings?.provider || "") || "Not set";
  const enabledFallbacks = Object.values(sttSettings?.cloud_fallback_providers || {})
    .filter((provider) => provider?.enabled)
    .map((provider) => provider.name);
  const livePath = [
    providerName !== "Not set" ? providerName : null,
    enabledFallbacks.length ? `fallback ${enabledFallbacks.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  if (activeProbe?.healthy) {
    return {
      details: [
        { label: "Live path", value: livePath || "Configured backend" },
        {
          label: "Probe",
          value:
            activeProbe.backend === "modal"
              ? "Modal fallback healthy"
              : "Primary import probe healthy",
        },
        { label: "Endpoint", value: activeProbe.url || "Configured backend" },
        {
          label: "Latency",
          value: activeProbe.latency_ms ? `${activeProbe.latency_ms} ms` : "Healthy",
        },
      ],
      state: "healthy",
      summary: "STT responded to the home probe.",
    };
  }

  const homeProbe = activeProbe?.error || probeError || "Not verified on home";
  const canFallback =
    Boolean(sttSettings) &&
    (!sttSettings.local_only ||
      enabledFallbacks.length > 0 ||
      Boolean(sttSettings.external_fallback_http_url || sttSettings.external_fallback_ws_url));

  return {
    details: [
      { label: "Live path", value: livePath || "Configured backend" },
      {
        label: "Mode",
        value: sttSettings ? (sttSettings.local_only ? "Local only" : "Remote + fallback") : "Unknown",
      },
      { label: "Home probe", value: homeProbe },
      { label: "Meaning", value: "Home checks the import STT path, not the full live fallback chain." },
    ],
    state: canFallback ? "configured" : "unavailable",
    summary: canFallback
      ? "STT is configured, but home is only checking the older import probe."
      : "STT home probe is unavailable.",
  };
}

export default function ServiceStatus({ className = "" }) {
  const [importStatus, setImportStatus] = useState(null);
  const [llmSettings, setLlmSettings] = useState(null);
  const [sttSettings, setSttSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probeError, setProbeError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      const [importResult, llmResult, sttResult] = await Promise.allSettled([
        fetchJson("/api/import/status"),
        fetchJson("/api/settings/llm"),
        fetchJson("/api/settings/stt"),
      ]);

      if (cancelled) {
        return;
      }

      if (importResult.status === "fulfilled") {
        setImportStatus(importResult.value);
        setProbeError(null);
      } else {
        setImportStatus(null);
        setProbeError(summarizeError(importResult.reason));
      }

      if (llmResult.status === "fulfilled") {
        setLlmSettings(llmResult.value);
      }

      if (sttResult.status === "fulfilled") {
        setSttSettings(sttResult.value);
      }

      setLoading(false);
    };

    fetchStatus();
    const intervalId = window.setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  if (loading && !llmSettings && !sttSettings && !importStatus) {
    return (
      <div className={`text-[11px] text-slate-400 ${className}`}>
        Checking live setup...
      </div>
    );
  }

  const llmSignal = buildLlmSignal(importStatus, llmSettings, probeError);
  const sttSignal = buildSttSignal(importStatus, sttSettings, probeError);

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <StatusPill label="STT" {...sttSignal} />
      <StatusPill label="LLM" {...llmSignal} />
    </div>
  );
}

ServiceStatus.propTypes = {
  className: PropTypes.string,
};
