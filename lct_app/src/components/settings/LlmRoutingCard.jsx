import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../services/apiClient";
import { getLlmSettings } from "../../services/llmSettingsApi";
import LlmSettingsPanel from "../LlmSettingsPanel";
import LlmProvidersPanel from "../LlmProvidersPanel";
import { buildLlmRoutingState, summarizeLlmRouting } from "./settingsSummary";

export default function LlmRoutingCard() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("Loading intelligence routing...");
  const [routingState, setRoutingState] = useState(null);
  const [error, setError] = useState(null);

  const refreshSummary = useCallback(async () => {
    try {
      const [providersResponse, settings] = await Promise.all([
        apiFetch("/api/settings/llm/providers"),
        getLlmSettings(),
      ]);
      if (!providersResponse.ok) {
        throw new Error("Failed to load intelligence routing summary");
      }
      const providers = await providersResponse.json();
      setRoutingState(buildLlmRoutingState(providers, settings));
      setSummary(summarizeLlmRouting(providers, settings));
      setError(null);
    } catch (err) {
      console.error("Unable to load intelligence routing summary:", err);
      setSummary("Unable to load intelligence routing");
      setRoutingState(null);
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  return (
    <section className="rounded-lg bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">Intelligence Routing</h2>
          <p className="mt-1 text-sm text-gray-500">
            Primary route plus fallback chain for graph generation and transcript accumulation.
          </p>
          <p className="mt-2 text-xs text-gray-600">{summary}</p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <button
          onClick={() => setOpen((current) => !current)}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          type="button"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 border-t border-gray-200 pt-4">
          {routingState ? (
            <div className="mb-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Primary route</p>
                <p className="mt-1 text-sm font-medium text-slate-800">{routingState.primaryLabel}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {routingState.mode === "online"
                    ? "Online Gemini runs first; local providers only run after online-mode failure."
                    : "The first enabled provider runs first for intelligence requests."}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Fallback order</p>
                <p className="mt-1 text-sm font-medium text-slate-800">
                  {routingState.fallbackLabels.length
                    ? routingState.fallbackLabels.join(" -> ")
                    : "None configured"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Providers are tried top-to-bottom after the primary route fails.
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Scope</p>
                <p className="mt-1 text-sm font-medium text-slate-800">{routingState.scopeLabel}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Model selection and provider ordering both affect the live graph path.
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-4">
            <section className="rounded-xl border border-slate-200 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-slate-800">Primary route controls</h3>
                <p className="text-xs text-slate-500">
                  Set the top-level mode and accepted model. Online mode uses Gemini as the primary
                  route; local mode starts with the first enabled provider below.
                </p>
              </div>
              <LlmSettingsPanel embedded onSaved={refreshSummary} />
            </section>

            <section className="rounded-xl border border-slate-200 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-slate-800">Fallback chain & health</h3>
                <p className="text-xs text-slate-500">
                  Reorder enabled providers to control local fallback order. Saved API keys remain
                  server-side, and health checks probe the actual configured provider endpoints.
                </p>
              </div>
              <LlmProvidersPanel embedded onSaved={refreshSummary} />
            </section>
          </div>
        </div>
      ) : null}
    </section>
  );
}
