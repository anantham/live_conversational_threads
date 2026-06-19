import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiFetch, readErrorMessage } from "../services/apiClient";

const POLL_INTERVAL_MS = 30000;
// Quick settings GETs.
const SETTINGS_TIMEOUT_MS = 8000;
// Live provider probes do a real round-trip — the backend cloud-provider-test
// alone allows up to 20s — so the client must wait well past that, or every
// probe falsely reports a timeout before the backend has even answered.
const PROBE_TIMEOUT_MS = 25000;
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
  const message = String(error.message || error).trim();
  return message || "Unavailable";
}

async function fetchWithTimeout(path, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchJson(path, timeoutMs = SETTINGS_TIMEOUT_MS) {
  const response = await fetchWithTimeout(path, {}, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(path, payload, timeoutMs = PROBE_TIMEOUT_MS) {
  const response = await fetchWithTimeout(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  if (!response.ok) {
    // Diagnostics panel — allow a larger body so proxy/5xx tracebacks survive.
    throw new Error(await readErrorMessage(response, `HTTP ${response.status}`, { cap: 1000 }));
  }
  return response.json();
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

      <div className="pointer-events-none fixed inset-x-3 bottom-16 z-20 translate-y-2 rounded-2xl border border-slate-200 bg-white/95 p-3 text-left opacity-0 shadow-xl backdrop-blur transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-3 sm:w-[min(22rem,calc(100vw-3rem))]">
        <p className="text-[11px] font-semibold text-slate-800">{summary}</p>
        <div className="mt-2 space-y-1.5">
          {details.map((detail, i) => (
            // Include the index: a pill can carry two details with the same
            // label (e.g. the LLM lane listing the same engine twice), which
            // collided on `${label}-${detail.label}` and logged a React
            // duplicate-key warning on every home load.
            <div key={`${label}-${detail.label}-${i}`} className="flex items-start justify-between gap-3 text-[11px]">
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

  // No probe results yet (results.length === 0). Don't claim "nothing configured"
  // when a provider IS set in Settings — that's misleading (it's usually just the
  // pre-probe / loading window). Reflect the configured provider instead.
  const configuredProviderName = toTitleCase(String(sttSettings?.provider || "").trim());
  return {
    details: [
      { label: "Primary", value: configuredProviderName || "Not set" },
      {
        label: "Probe",
        value:
          probeError || (configuredProviderName ? "Probing configured route…" : "No configured live STT routes"),
      },
      { label: "Meaning", value: "Home checks the current settings-driven live STT routes." },
    ],
    state: sttSettings ? "configured" : "unavailable",
    summary: !sttSettings
      ? "STT settings are unavailable."
      : configuredProviderName
        ? `${configuredProviderName} is configured; probing its live route…`
        : "No probeable live STT routes are configured.",
  };
}

// ── backend-catalog enrichment ───────────────────────────────────────────────
// The chips used to show a generic provider name ("Whisper") and reported the
// /health PING as "Latency". We now pull the active backend from the catalog so
// the tooltip shows model, where-it-runs, empirical speed/accuracy, and cost —
// and we relabel the ping so it's not confused with inference latency.

function catalogActive(catalog, capability) {
  if (!catalog) return null;
  const activeId = catalog.active && catalog.active[capability];
  return (catalog[capability] || []).find((entry) => entry.id === activeId) || null;
}

function shortName(entry) {
  return entry ? String(entry.display_name || "").split(" (")[0] : "";
}

function locShort(runtime) {
  if (!runtime) return "local";
  if (runtime.startsWith("cloud-")) return "cloud";
  if (runtime === "m5-ane") return "ANE";
  if (runtime === "tailscale-rtx") return "RTX";
  return "local";
}

function catalogDetailRows(entry, capability) {
  if (!entry) return [];
  const m = entry.measured || {};
  const o = entry.observed || null;
  const rows = [
    { label: "Backend", value: entry.display_name },
    { label: "Model", value: entry.model || "—" },
    { label: "Runs on", value: entry.runtime_label || entry.runtime || "—" },
  ];
  if (capability === "llm") {
    if (o && o.avg_tokens_per_sec) {
      rows.push({ label: "Speed (live)", value: `${o.avg_tokens_per_sec} tok/s · ${o.samples} samples` });
    } else {
      rows.push({ label: "Speed", value: "measured live from your usage" });
    }
  } else {
    if (m.speedup_vs_realtime) {
      rows.push({ label: "Speed", value: `${Math.round(m.speedup_vs_realtime * 10) / 10}× realtime (benchmark)` });
    }
    if (o && o.avg_request_ms) {
      rows.push({ label: "Speed (live)", value: `${Math.round(o.avg_request_ms)} ms/req · ${o.samples} samples` });
    }
  }
  if (capability === "stt" && typeof m.wer_vs_ref === "number") {
    rows.push({ label: "Accuracy", value: m.wer_vs_ref === 0 ? "reference" : `WER ${m.wer_vs_ref.toFixed(3)} vs ref` });
  }
  if (capability === "diarization") {
    rows.push({ label: "Voice ID", value: entry.emits_embeddings ? "yes (speaker embeddings)" : "no (labels only)" });
  }
  const c = entry.cost || {};
  rows.push({
    label: "Cost",
    value: c.free_local
      ? "Free · local"
      : typeof c.per_minute === "number"
      ? `~$${c.per_minute}/min${c.approximate ? " (approx)" : ""}`
      : typeof c.per_million_tokens === "number"
      ? `~$${c.per_million_tokens}/1M tok${c.approximate ? " (approx)" : ""}`
      : "Paid",
  });
  return rows;
}

function mergeCatalogDetails(signal, entry, capability) {
  if (!entry) return signal;
  const existing = (signal.details || []).map((detail) =>
    detail.label === "Latency" ? { ...detail, label: "Health ping" } : detail,
  );
  return { ...signal, details: [...catalogDetailRows(entry, capability), ...existing] };
}

function buildDiarSignal(selected, effective, probe, sttEntry) {
  // Speakers can come from the STT provider itself (some whisper/cloud routes
  // diarize) — track that so we never falsely claim "nothing running".
  const sttDiar = sttEntry && sttEntry.provides_diarization ? sttEntry : null;

  if (!selected && !effective && !sttDiar) {
    return {
      details: [{ label: "Status", value: "No diarization backend configured" }],
      state: "unavailable",
      summary: "Diarization is not configured.",
    };
  }
  // No dedicated diarizer running.
  if (!effective) {
    if (sttDiar) {
      const details = [{ label: "Source", value: `STT provider (${shortName(sttDiar)})` }];
      if (selected) {
        details.push({
          label: "Selected diarizer",
          value: `${shortName(selected)}${selected.status === "planned" ? " (planned)" : ""} — not running`,
        });
      }
      return {
        details,
        state: "configured",
        summary: `Speaker labels come from your STT provider (${shortName(sttDiar)}); no separate diarizer is running.`,
      };
    }
    const details = selected ? catalogDetailRows(selected, "diarization") : [];
    details.push({
      label: "Status",
      value:
        selected && selected.status === "planned"
          ? "Selected backend not built (sidecar missing)"
          : "Selected backend not running",
    });
    return {
      details,
      state: "unavailable",
      summary: selected
        ? `${selected.display_name} is selected, but nothing is running — diarization is off.`
        : "No diarizer running.",
    };
  }
  // pyannote is degraded on Apple Silicon, so even when it serves we stay amber.
  let state = effective.degraded ? "configured" : "healthy";
  if (probe && probe.ok === false) state = "unavailable";
  const details = [];
  if (selected && selected.id !== effective.id) {
    details.push({
      label: "Note",
      value: `Serving ${shortName(effective)} — you selected ${shortName(selected)}${selected.status === "planned" ? " (planned)" : ""}`,
    });
  }
  details.push(...catalogDetailRows(effective, "diarization"));
  if (effective.degraded) details.push({ label: "Caveat", value: "degraded on Apple Silicon (MPS wrong; CPU slow)" });
  if (probe && probe.error) details.push({ label: "Probe", value: probe.error });
  return {
    details,
    state,
    summary: `Diarization via ${effective.display_name} (${effective.runtime_label || effective.runtime}).`,
  };
}

export default function ServiceStatus({ className = "" }) {
  const [llmSettings, setLlmSettings] = useState(null);
  const [llmProvidersConfig, setLlmProvidersConfig] = useState(null);
  const [sttSettings, setSttSettings] = useState(null);
  const [llmProbe, setLlmProbe] = useState(null);
  const [sttProbe, setSttProbe] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [diarProbe, setDiarProbe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probeError, setProbeError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      setLoading(true);

      const [llmResult, llmProvidersResult, sttResult, catalogResult] = await Promise.allSettled([
        fetchJson("/api/settings/llm"),
        fetchJson("/api/settings/llm/providers"),
        fetchJson("/api/settings/stt"),
        fetchJson("/api/backend-catalog"),
      ]);

      if (cancelled) {
        return;
      }

      const nextLlmSettings = llmResult.status === "fulfilled" ? llmResult.value : null;
      const nextLlmProvidersConfig =
        llmProvidersResult.status === "fulfilled" ? llmProvidersResult.value : null;
      const nextSttSettings = sttResult.status === "fulfilled" ? sttResult.value : null;
      const nextCatalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;

      setLlmSettings(nextLlmSettings);
      setLlmProvidersConfig(nextLlmProvidersConfig);
      setSttSettings(nextSttSettings);
      setCatalog(nextCatalog);

      // Live-probe the EFFECTIVE diarization backend — what actually serves —
      // not the selected-but-not-running preference (STT/LLM keep their richer probes).
      const probeDiarId = nextCatalog?.active?.diarization_effective || nextCatalog?.active?.diarization;
      if (probeDiarId) {
        postJson("/api/backend-catalog/probe", { capability: "diarization", id: probeDiarId })
          .then((result) => {
            if (!cancelled) setDiarProbe(result);
          })
          .catch((err) => {
            if (!cancelled) setDiarProbe({ ok: false, error: summarizeError(err) });
          });
      }

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

  const sttEntry = catalogActive(catalog, "stt");
  const llmEntry = catalogActive(catalog, "llm");
  const diarSelected = catalogActive(catalog, "diarization");
  const diarEffectiveId = catalog?.active?.diarization_effective;
  const diarEffective = diarEffectiveId ? (catalog.diarization || []).find((e) => e.id === diarEffectiveId) : null;

  const llmSignal = mergeCatalogDetails(buildLlmSignal(llmSettings, llmProbe, probeError), llmEntry, "llm");
  const sttSignal = mergeCatalogDetails(buildSttSignal(sttSettings, sttProbe, probeError), sttEntry, "stt");
  const diarSignal = buildDiarSignal(diarSelected, diarEffective, diarProbe, sttEntry);

  const sttLabel = sttEntry ? `STT: ${shortName(sttEntry)} (${locShort(sttEntry.runtime)})` : "STT";
  const llmLabel = llmEntry ? `LLM: ${shortName(llmEntry)} (${locShort(llmEntry.runtime)})` : "LLM";
  const diarLabel = diarEffective
    ? `Speakers: ${shortName(diarEffective)} (${locShort(diarEffective.runtime)})`
    : sttEntry && sttEntry.provides_diarization
    ? "Speakers: via STT"
    : diarSelected
    ? "Speakers: none running"
    : "Speakers";

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <StatusPill label={sttLabel} {...sttSignal} />
      <StatusPill label={diarLabel} {...diarSignal} />
      <StatusPill label={llmLabel} {...llmSignal} />
    </div>
  );
}

ServiceStatus.propTypes = {
  className: PropTypes.string,
};
