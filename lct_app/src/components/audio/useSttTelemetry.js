import { useCallback, useEffect, useState } from "react";

import { getSttTelemetry } from "../../services/sttSettingsApi";

/**
 * Polls STT telemetry metrics at a configurable interval.
 * Returns the latest telemetry snapshot plus loading/error state.
 */
export default function useSttTelemetry({ autoRefreshMs = 5000 } = {}) {
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await getSttTelemetry(500);
      setTelemetry(data);
    } catch (err) {
      console.error("Failed to load STT telemetry:", err);
      setError("Unable to load STT telemetry.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh({ silent: true }), autoRefreshMs);
    return () => clearInterval(id);
  }, [autoRefreshMs, refresh]);

  return { telemetry, loading, error, refresh };
}
