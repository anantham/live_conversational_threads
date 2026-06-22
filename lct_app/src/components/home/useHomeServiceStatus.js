import { useEffect, useMemo, useState } from "react";

import {
  POLL_INTERVAL_MS,
  buildHomeStatusPresentation,
  fetchJson,
  postJson,
  probeConfiguredLlm,
  probeConfiguredStt,
  summarizeError,
} from "./homeServiceStatusLogic";

export function useHomeServiceStatus() {
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

  return { loading, showInitialLoading, ...presentation };
}