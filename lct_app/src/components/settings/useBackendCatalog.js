import { useCallback, useEffect, useRef, useState } from 'react';

import { getBackendCatalog, probeBackend } from '../../services/backendCatalogApi';

const DEFAULT_POLL_MS = 30000;

/**
 * Loads the inference backend catalog (STT / Diarization / LLM lanes) and lets
 * callers live-probe individual backends. Probe results are kept keyed by
 * `${capability}:${id}` and merged into the entries the consumer renders.
 *
 * Seed-then-refine: the catalog already carries benchmark `measured` numbers and
 * live `observed` telemetry from the server; this hook layers on on-demand health
 * probes so the UI can show "online right now" per backend.
 */
export function useBackendCatalog({ pollMs = DEFAULT_POLL_MS, autoProbeActive = true } = {}) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [probes, setProbes] = useState({});
  const mounted = useRef(true);
  const autoProbedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getBackendCatalog();
      if (!mounted.current) return next;
      setCatalog(next);
      setError(null);
      return next;
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to load backend catalog');
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const probe = useCallback(async (capability, id) => {
    const key = `${capability}:${id}`;
    setProbes((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), checking: true } }));
    try {
      const result = await probeBackend({ capability, id });
      if (mounted.current) {
        setProbes((prev) => ({ ...prev, [key]: { ...result, checking: false } }));
      }
      return result;
    } catch (err) {
      const failure = { ok: false, checking: false, error: err.message || 'probe failed' };
      if (mounted.current) setProbes((prev) => ({ ...prev, [key]: failure }));
      return failure;
    }
  }, []);

  const probeAll = useCallback(
    async (cat) => {
      const source = cat || catalog;
      if (!source) return;
      const jobs = [];
      ['stt', 'diarization', 'llm'].forEach((capability) => {
        (source[capability] || []).forEach((entry) => {
          // Skip cloud/unconfigured backends that have nothing to probe.
          const hasProbe = (entry.health && entry.health.probe_url) || entry.is_active;
          if (hasProbe) jobs.push(probe(capability, entry.id));
        });
      });
      await Promise.allSettled(jobs);
    },
    [catalog, probe],
  );

  useEffect(() => {
    mounted.current = true;
    refresh().then((cat) => {
      if (autoProbeActive && cat && !autoProbedRef.current) {
        autoProbedRef.current = true;
        // Probe just the active backend in each lane on first load.
        ['stt', 'diarization', 'llm'].forEach((capability) => {
          const activeId = cat.active && cat.active[capability];
          if (activeId) probe(capability, activeId);
        });
      }
    });
    const timer = pollMs ? setInterval(refresh, pollMs) : null;
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, [refresh, probe, pollMs, autoProbeActive]);

  return { catalog, loading, error, probes, refresh, probe, probeAll };
}

export default useBackendCatalog;
