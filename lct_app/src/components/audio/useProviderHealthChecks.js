import { useCallback, useState } from "react";

import { checkSttProviderHealth } from "../../services/sttSettingsApi";

/**
 * Manages per-provider health check state.
 * Each provider has its own checking/result/error state.
 */
export default function useProviderHealthChecks() {
  const [healthByProvider, setHealthByProvider] = useState({});

  const checkHealth = useCallback(async (providerId, wsUrl) => {
    setHealthByProvider((prev) => ({
      ...prev,
      [providerId]: {
        ...(prev?.[providerId] || {}),
        checking: true,
        error: null,
      },
    }));
    try {
      const result = await checkSttProviderHealth({
        provider: providerId,
        ws_url: wsUrl,
      });
      setHealthByProvider((prev) => ({
        ...prev,
        [providerId]: { ...result, checking: false },
      }));
    } catch (err) {
      const message = err?.message || "Health check failed.";
      setHealthByProvider((prev) => ({
        ...prev,
        [providerId]: {
          ...(prev?.[providerId] || {}),
          checking: false,
          ok: false,
          error: message,
          checked_at: new Date().toISOString(),
        },
      }));
    }
  }, []);

  return { healthByProvider, checkHealth };
}
