import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiFetch } from "../services/apiClient";

const POLL_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 3000;
const DEFAULT_FALLBACK_PRIORITY = [
  "remote_whisper",
  "external_http",
  "openai_audio",
  "openrouter_audio",
];

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

async function postJson(path, payload) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
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

function isConfiguredCloudProvider(provider) {
  return Boolean(
    provider?.enabled &&
      provider?.base_url &&
      provider?.model &&
      (provider?.has_api_key || provider?.api_key)
  );
}

function buildSttProbePlan(sttSettings) {
  if (!sttSettings) {
    return [];
  }

  const probes = [];
  const seen = new Set();
  const configuredProvider = String(sttSettings.provider || "").trim().toLowerCase();
  const providerHttpUrls =
    sttSettings.provider_http_urls && typeof sttSettings.provider_http_urls === "object"
      ? sttSettings.provider_http_urls
      : {};
  const cloudProviders =
    sttSettings.cloud_fallback_providers && typeof sttSettings.cloud_fallback_providers === "object"
      ? sttSettings.cloud_fallback_providers
      : {};
  const fallbackPriority = Array.isArray(sttSettings.live_fallback_priority)
    ? sttSettings.live_fallback_priority
    : DEFAULT_FALLBACK_PRIORITY;

  const addProbe = (probe) => {
    const key = `${probe.routeId}:${probe.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(probe);
  };

  if (configuredProvider) {
    if (configuredProvider === "openai_audio" || configuredProvider === "openrouter_audio") {
      addProbe({
        routeId: "configured_provider",
        label: toTitleCase(configuredProvider),
        pathLabel: "Primary",
        check: () =>
          postJson("/api/settings/stt/cloud-provider-test", {
            provider: configuredProvider,
          }),
      });
    } else {
      addProbe({
        routeId: "configured_provider",
        label: toTitleCase(configuredProvider),
        pathLabel: "Primary",
        check: () =>
          postJson("/api/settings/stt/health-check", {
            provider: configuredProvider,
          }),
      });
    }
  }

  if (sttSettings.local_only) {
    return probes;
  }

  for (const routeId of fallbackPriority) {
    if (routeId === "remote_whisper") {
      const whisperHttpUrl = String(providerHttpUrls.whisper || "").trim();
      if (configuredProvider !== "whisper" && whisperHttpUrl) {
        addProbe({
          routeId,
          label: "Remote Whisper",
          pathLabel: "Fallback",
          check: () =>
            postJson("/api/settings/stt/health-check", {
              provider: "whisper",
              http_url: whisperHttpUrl,
            }),
        });
      }
    }

    if (routeId === "openai_audio" || routeId === "openrouter_audio") {
      const provider = cloudProviders[routeId];
      if (isConfiguredCloudProvider(provider)) {
        addProbe({
          routeId,
          label: provider.name || toTitleCase(routeId),
          pathLabel: "Fallback",
          check: () =>
            postJson("/api/settings/stt/cloud-provider-test", {
              provider: routeId,
            }),
        });
      }
    }

    if (routeId === "external_http") {
      const externalHttpUrl = String(sttSettings.external_fallback_http_url || "").trim();
      if (externalHttpUrl) {
        addProbe({
          routeId,
          label: "External HTTP",
          pathLabel: "Fallback",
          configuredOnly: true,
          endpoint: externalHttpUrl,
        });
      }
    }
  }

  return probes;
}

async function probeConfiguredStt(sttSettings) {
  const plan = buildSttProbePlan(sttSettings);
  if (!plan.length) {
    return { plan: [], results: [] };
  }

  const settled = await Promise.all(
    plan.map(async (probe) => {
      if (probe.configuredOnly) {
        return {
          ...probe,
          healthy: false,
          configuredOnly: true,
          error: "Configured but not directly probeable from the home chip",
          url: probe.endpoint,
        };
      }

      try {
        const result = await probe.check();
        return {
          ...probe,
          healthy: Boolean(result?.healthy ?? result?.ok),
          latency_ms: result?.latency_ms,
          error: result?.error || null,
          status_code: result?.status_code,
          url: result?.url || result?.health_url || probe.endpoint || null,
        };
      } catch (error) {
        return {
          ...probe,
          healthy: false,
          error: summarizeError(error),
          url: probe.endpoint || null,
        };
      }
    })
  );

  return { plan, results: settled };
}

function getEnabledLlmProviders(llmProvidersConfig) {
  return Array.isArray(llmProvidersConfig?.providers)
    ? llmProvidersConfig.providers.filter((provider) => provider?.enabled !== false)
    : [];
}

function buildLlmProbePlan(llmSettings, llmProvidersConfig) {
  if (!llmSettings) {
    return [];
  }

  const plan = [];
  const mode = String(llmSettings.mode || "local").trim().toLowerCase();
  const enabledProviders = getEnabledLlmProviders(llmProvidersConfig);

  if (mode === "online") {
    plan.push({
      routeId: "online_primary",
      label: llmSettings.chat_model || "Gemini Online",
      pathLabel: "Primary",
      check: () => fetchJson("/api/settings/llm/models?mode=online"),
      normalizeResult: (result) => ({
        healthy: Array.isArray(result?.models) && result.models.length > 0,
        source: result?.source || "unknown",
      }),
    });
  }

  if (enabledProviders.length) {
    enabledProviders.forEach((provider, index) => {
      plan.push({
        routeId: provider.id || `provider_${index}`,
        label: provider.name || provider.id || "provider",
        pathLabel: mode === "online" || index > 0 ? "Fallback" : "Primary",
        providerType: provider.type || "openai_compatible",
        check: () =>
          postJson("/api/settings/llm/providers/health", {
            provider,
          }),
      });
    });
  } else if (mode !== "online" && llmSettings.base_url) {
    plan.push({
      routeId: "legacy_local",
      label: llmSettings.chat_model || "Configured endpoint",
      pathLabel: "Primary",
      providerType: "openai_compatible",
      check: () =>
        postJson("/api/settings/llm/providers/health", {
          provider: {
            id: "home-status",
            base_url: llmSettings.base_url,
            model: llmSettings.chat_model,
            type: "openai_compatible",
          },
        }),
    });
  }

  return plan;
}

async function probeConfiguredLlm(llmSettings, llmProvidersConfig) {
  const plan = buildLlmProbePlan(llmSettings, llmProvidersConfig);
  if (!plan.length) {
    return { plan: [], results: [], mode: llmSettings?.mode || "local" };
  }

  const results = await Promise.all(
    plan.map(async (probe) => {
      try {
        const result = await probe.check();
        const normalized = probe.normalizeResult ? probe.normalizeResult(result) : {};
        return {
          ...probe,
          healthy: Boolean(normalized.healthy ?? result?.healthy),
          latency_ms: result?.latency_ms,
          error: result?.error || null,
          source: normalized.source || result?.source || null,
          status_code: result?.status_code,
          url: result?.url || probe.endpoint || null,
        };
      } catch (error) {
        return {
          ...probe,
          healthy: false,
          error: summarizeError(error),
          url: probe.endpoint || null,
        };
      }
    })
  );

  return {
    mode: llmSettings?.mode || "local",
    plan,
    results,
    model: llmSettings?.chat_model || "Not set",
  };
}

function buildLlmSignal(llmSettings, llmProbe, probeError) {
  const mode = llmSettings?.mode || "local";
  const model = llmSettings?.chat_model || "Not set";
  const results = Array.isArray(llmProbe?.results) ? llmProbe.results : [];
  const healthyResult = results.find((result) => result.healthy);
  const checkedCount = results.length;

  if (healthyResult) {
    return {
      details: [
        {
          label: "Active route",
          value: `${healthyResult.pathLabel}: ${healthyResult.label}`,
        },
        { label: "Mode", value: toTitleCase(mode) },
        {
          label: "Probe",
          value:
            mode === "online" && healthyResult.routeId === "online_primary"
              ? `Online catalog (${healthyResult.source || "ready"})`
              : (healthyResult.url || "Configured endpoint"),
        },
        {
          label: "Checked",
          value: `${checkedCount} route${checkedCount === 1 ? "" : "s"}`,
        },
      ],
      state: "healthy",
      summary:
        mode === "online"
          ? "A configured intelligence route responded, using the current online-primary plus fallback chain."
          : "A configured intelligence route responded through the current local provider chain.",
    };
  }

  if (results.length) {
    const firstFailure = results.find((result) => result.error)?.error;
    return {
      details: [
        { label: "Mode", value: toTitleCase(mode) || "Unknown" },
        { label: "Primary", value: results[0]?.label || model },
        { label: "Checked", value: `${checkedCount} route${checkedCount === 1 ? "" : "s"}` },
        { label: "Probe", value: firstFailure || probeError || "No healthy configured routes" },
      ],
      state: llmSettings ? "configured" : "unavailable",
      summary: llmSettings
        ? "LLM routing is configured, but none of the current intelligence routes passed the home probe."
        : "LLM settings are unavailable.",
    };
  }

  return {
    details: [
      { label: "Mode", value: toTitleCase(mode) || "Unknown" },
      { label: "Model", value: model },
      { label: "Probe", value: probeError || "Not verified" },
      { label: "Endpoint", value: llmSettings?.base_url || "Not set" },
    ],
    state: llmSettings ? "configured" : "unavailable",
    summary: llmSettings
      ? "LLM is configured, but the current settings probe did not verify it."
      : "LLM settings are unavailable.",
  };
}

function buildSttSignal(sttSettings, sttProbe, probeError) {
  const results = Array.isArray(sttProbe?.results) ? sttProbe.results : [];
  const healthyResult = results.find((result) => result.healthy);
  const checkedCount = results.filter((result) => !result.configuredOnly).length;
  const configuredOnlyCount = results.filter((result) => result.configuredOnly).length;

  if (healthyResult) {
    return {
      details: [
        {
          label: "Active route",
          value: `${healthyResult.pathLabel}: ${healthyResult.label}`,
        },
        {
          label: "Endpoint",
          value: healthyResult.url || "Configured backend",
        },
        {
          label: "Latency",
          value: healthyResult.latency_ms ? `${healthyResult.latency_ms} ms` : "Healthy",
        },
        {
          label: "Checked",
          value: `${checkedCount} route${checkedCount === 1 ? "" : "s"}${configuredOnlyCount ? ` + ${configuredOnlyCount} configured-only` : ""}`,
        },
      ],
      state: "healthy",
      summary: "A currently configured live STT route responded successfully.",
    };
  }

  if (results.length) {
    const firstFailure = results.find((result) => !result.configuredOnly)?.error;
    return {
      details: [
        {
          label: "Primary",
          value: toTitleCase(sttSettings?.provider || "") || "Not set",
        },
        {
          label: "Checked",
          value: `${checkedCount} route${checkedCount === 1 ? "" : "s"}${configuredOnlyCount ? ` + ${configuredOnlyCount} configured-only` : ""}`,
        },
        {
          label: "Probe",
          value: firstFailure || probeError || "No healthy configured routes",
        },
        {
          label: "Meaning",
          value: "Home now checks the live routes configured in Settings.",
        },
      ],
      state: checkedCount > 0 || configuredOnlyCount > 0 ? "configured" : "unavailable",
      summary:
        checkedCount > 0 || configuredOnlyCount > 0
          ? "STT is configured, but none of the current live routes passed the home probe."
          : "STT settings are unavailable.",
    };
  }

  return {
    details: [
      { label: "Primary", value: toTitleCase(sttSettings?.provider || "") || "Not set" },
      { label: "Probe", value: probeError || "No configured live STT routes" },
      { label: "Meaning", value: "Home checks the current settings-driven live STT routes." },
    ],
    state: sttSettings ? "configured" : "unavailable",
    summary: sttSettings
      ? "No probeable live STT routes are configured."
      : "STT settings are unavailable.",
  };
}

export default function ServiceStatus({ className = "" }) {
  const [llmSettings, setLlmSettings] = useState(null);
  const [llmProvidersConfig, setLlmProvidersConfig] = useState(null);
  const [sttSettings, setSttSettings] = useState(null);
  const [llmProbe, setLlmProbe] = useState(null);
  const [sttProbe, setSttProbe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probeError, setProbeError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      setLoading(true);

      const [llmResult, llmProvidersResult, sttResult] = await Promise.allSettled([
        fetchJson("/api/settings/llm"),
        fetchJson("/api/settings/llm/providers"),
        fetchJson("/api/settings/stt"),
      ]);

      if (cancelled) {
        return;
      }

      const nextLlmSettings = llmResult.status === "fulfilled" ? llmResult.value : null;
      const nextLlmProvidersConfig =
        llmProvidersResult.status === "fulfilled" ? llmProvidersResult.value : null;
      const nextSttSettings = sttResult.status === "fulfilled" ? sttResult.value : null;

      setLlmSettings(nextLlmSettings);
      setLlmProvidersConfig(nextLlmProvidersConfig);
      setSttSettings(nextSttSettings);

      if (
        llmResult.status === "rejected" ||
        llmProvidersResult.status === "rejected" ||
        sttResult.status === "rejected"
      ) {
        setProbeError(
          summarizeError(
            llmResult.status === "rejected"
              ? llmResult.reason
              : llmProvidersResult.status === "rejected"
              ? llmProvidersResult.reason
              : sttResult.reason
          )
        );
      } else {
        setProbeError(null);
      }

      const [resolvedLlmProbe, resolvedSttProbe] = await Promise.all([
        probeConfiguredLlm(nextLlmSettings, nextLlmProvidersConfig),
        probeConfiguredStt(nextSttSettings),
      ]);

      if (cancelled) {
        return;
      }

      setLlmProbe(resolvedLlmProbe);
      setSttProbe(resolvedSttProbe);
      setLoading(false);
    };

    fetchStatus();
    const intervalId = window.setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  if (loading && !llmSettings && !llmProvidersConfig && !sttSettings && !llmProbe && !sttProbe) {
    return (
      <div className={`text-[11px] text-slate-400 ${className}`}>
        Checking live setup...
      </div>
    );
  }

  const llmSignal = buildLlmSignal(llmSettings, llmProbe, probeError);
  const sttSignal = buildSttSignal(sttSettings, sttProbe, probeError);

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
