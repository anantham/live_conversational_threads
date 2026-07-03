import { useEffect, useMemo, useState } from "react";

import { useDataProvider } from "../../services/dataProvider";
import {
  POLL_INTERVAL_MS,
  buildHomeStatusPresentation,
  fetchJson,
  postJson,
  probeConfiguredLlm,
  probeConfiguredStt,
  summarizeError,
} from "./homeServiceStatusLogic";

// In serverless (BYOK) mode there is no Python backend to probe — STT/LLM/
// diarization all run browser -> Vercel proxy -> OpenAI with the visitor's key.
// Probing /api/settings/* there just hits the SPA rewrite and returns HTML
// ("Unexpected token '<'"), so show serverless-accurate pills and skip the calls.
const SERVERLESS_PRESENTATION = {
  sttLabel: "STT: OpenAI (BYOK)",
  llmLabel: "LLM: OpenAI (BYOK)",
  diarLabel: "Speakers: OpenAI diarize",
  sttSignal: {
    state: "healthy",
    summary: "Serverless mode: speech-to-text runs via OpenAI with your key.",
    details: [
      { label: "Mode", value: "Serverless (BYOK)" },
      { label: "Route", value: "browser → Vercel → OpenAI" },
    ],
  },
  llmSignal: {
    state: "healthy",
    summary: "Serverless mode: the graph LLM runs via OpenAI with your key.",
    details: [
      { label: "Mode", value: "Serverless (BYOK)" },
      { label: "Route", value: "browser → Vercel → OpenAI" },
    ],
  },
  diarSignal: {
    state: "healthy",
    summary: "Serverless mode: diarization via gpt-4o-transcribe-diarize.",
    details: [{ label: "Source", value: "OpenAI transcribe-diarize" }],
  },
};

export function useHomeServiceStatus() {
  const dataProvider = useDataProvider();
  const isServerless = Boolean(dataProvider?.isServerless);
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
    if (isServerless) {
      setLoading(false);
      return undefined; // no Python backend to probe in serverless mode
    }
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
  }, [isServerless]);

  const showInitialLoading = loading && !llmSettings && !llmProvidersConfig && !sttSettings && !llmProbe && !sttProbe;

  const presentation = useMemo(
    () => buildHomeStatusPresentation({
      llmSettings,
      llmProbe,
      sttSettings,
      sttProbe,
      catalog,
      diarProbe,
      probeError,
    }),
    [llmSettings, llmProbe, sttSettings, sttProbe, catalog, diarProbe, probeError],
  );

  if (isServerless) {
    return { loading: false, showInitialLoading: false, ...SERVERLESS_PRESENTATION };
  }

  return { loading, showInitialLoading, ...presentation };
}