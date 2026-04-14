import { useCallback, useEffect, useState } from "react";

import {
  getSttSettings,
  testSttCloudProvider,
  updateSttSettings,
} from "../../services/sttSettingsApi";
import {
  buildCloudProviderHttpUrl,
  normalizeLiveFallbackPriority,
  normalizeProvider,
  normalizeSttSettings,
} from "../audio/sttUtils";

const CLOUD_PROVIDER_LABELS = {
  openai_audio: "OpenAI Audio",
  openrouter_audio: "OpenRouter Audio",
};

function describeRequestError(err, fallbackMessage) {
  const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
  return isNetworkError ? "Backend unavailable" : fallbackMessage;
}

export default function useSttSettingsForm() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [cloudProviderChecks, setCloudProviderChecks] = useState({});

  const resolvePrimaryProviderHttpUrl = useCallback((draft, providerId) => {
    if (providerId === "openai_audio") {
      return (
        buildCloudProviderHttpUrl(
          "openai_audio",
          draft?.cloud_fallback_providers?.openai_audio,
        ) || draft?.provider_http_urls?.openai_audio || ""
      );
    }
    return draft?.provider_http_urls?.[providerId] || "";
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSttSettings();
      const normalized = normalizeSttSettings(data);
      setSettings(normalized);
      setForm(normalized);
      setCloudProviderChecks({});
    } catch (err) {
      console.error("Unable to load STT settings:", err);
      setError(describeRequestError(err, "Unable to load STT configuration."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clearCloudProviderCheck = useCallback((providerId) => {
    setCloudProviderChecks((prev) => {
      if (!prev?.[providerId]) {
        return prev;
      }
      const next = { ...(prev || {}) };
      delete next[providerId];
      return next;
    });
  }, []);

  const saveForm = useCallback(async (draft, successMessage = "Live STT settings saved.") => {
    if (!draft) return null;
    setSaving(true);
    setError(null);
    try {
      const normalized = normalizeSttSettings(draft, { preserveApiKeys: true });
      const payload = {
        ...normalized,
        ws_url: normalized.provider_urls?.[normalized.provider] || normalized.ws_url,
        http_url: resolvePrimaryProviderHttpUrl(normalized, normalized.provider),
      };
      const updated = await updateSttSettings(payload);
      const updatedNormalized = normalizeSttSettings(updated);
      setSettings(updatedNormalized);
      setForm(updatedNormalized);
      setFeedback({
        tone: "success",
        message: successMessage,
      });
      return updatedNormalized;
    } catch (err) {
      console.error("Failed to save STT settings:", err);
      setFeedback(null);
      setError(describeRequestError(err, "Unable to persist STT settings."));
      return null;
    } finally {
      setSaving(false);
    }
  }, [resolvePrimaryProviderHttpUrl]);

  const handleSave = useCallback(async () => {
    await saveForm(form);
  }, [form, saveForm]);

  const handleCloudProviderTest = useCallback(async (providerId) => {
    if (!form) return;

    const providerName = CLOUD_PROVIDER_LABELS[providerId] || providerId;
    const saved = await saveForm(form, "Live STT settings saved.");
    if (!saved) return;

    setError(null);
    setCloudProviderChecks((prev) => ({
      ...(prev || {}),
      [providerId]: {
        status: "testing",
        checking: true,
      },
    }));

    try {
      const result = await testSttCloudProvider({ provider: providerId });
      setCloudProviderChecks((prev) => ({
        ...(prev || {}),
        [providerId]: {
          ...result,
          checking: false,
        },
      }));
      setFeedback({
        tone: result?.ok ? "success" : "warning",
        message: result?.ok
          ? `${providerName} is ready for fallback tests.`
          : `${providerName} test failed: ${result?.error || result?.status || "unknown error"}`,
      });
    } catch (err) {
      console.error(`Failed to test cloud provider ${providerId}:`, err);
      const message = describeRequestError(
        err,
        `Unable to test ${providerName}.`,
      );
      setCloudProviderChecks((prev) => ({
        ...(prev || {}),
        [providerId]: {
          status: "provider_error",
          checking: false,
          ok: false,
          error: message,
        },
      }));
      setFeedback({
        tone: "warning",
        message,
      });
    }
  }, [form, saveForm]);

  const handleChange = useCallback((key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => {
      const next = { ...(prev || {}), [key]: value };
      if (key === "provider") {
        const normalizedProvider = normalizeProvider(value);
        next.provider = normalizedProvider;
        next.ws_url = next.provider_urls?.[normalizedProvider] || "";
        next.http_url = resolvePrimaryProviderHttpUrl(next, normalizedProvider);
      }
      return next;
    });
  }, [resolvePrimaryProviderHttpUrl]);

  const handleProviderUrlChange = useCallback((providerId) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...(prev || {}),
      provider_urls: {
        ...(prev?.provider_urls || {}),
        [providerId]: value,
      },
      ws_url:
        normalizeProvider(prev?.provider) === providerId
          ? value
          : prev?.ws_url || "",
    }));
  }, []);

  const handleProviderHttpUrlChange = useCallback((providerId) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...(prev || {}),
      provider_http_urls: {
        ...(prev?.provider_http_urls || {}),
        [providerId]: value,
      },
      http_url:
        normalizeProvider(prev?.provider) === providerId
          ? resolvePrimaryProviderHttpUrl(
              {
                ...(prev || {}),
                provider_http_urls: {
                  ...(prev?.provider_http_urls || {}),
                  [providerId]: value,
                },
              },
              providerId,
            )
          : prev?.http_url || "",
    }));
  }, [resolvePrimaryProviderHttpUrl]);

  const handleCloudFallbackFlagChange = useCallback((key) => (event) => {
    const checked = Boolean(event.target.checked);
    setForm((prev) => ({
      ...(prev || {}),
      [key]: checked,
    }));
  }, []);

  const handleCloudProviderFieldChange = useCallback(
    (providerId, field, valueType = "text") =>
      (event) => {
        const value = valueType === "checkbox" ? Boolean(event.target.checked) : event.target.value;
        clearCloudProviderCheck(providerId);
        setForm((prev) => {
          const currentProvider = prev?.cloud_fallback_providers?.[providerId] || {};
          const nextCloudProviders = {
            ...(prev?.cloud_fallback_providers || {}),
            [providerId]: {
              ...currentProvider,
              [field]: value,
              ...(field === "api_key" && String(value || "").trim()
                ? { clear_api_key: false }
                : {}),
            },
          };
          const nextProviderHttpUrls = {
            ...(prev?.provider_http_urls || {}),
          };
          if (providerId === "openai_audio" && field === "base_url") {
            nextProviderHttpUrls.openai_audio = buildCloudProviderHttpUrl(
              "openai_audio",
              nextCloudProviders.openai_audio,
            );
          }
          return {
            ...(prev || {}),
            cloud_fallback_providers: nextCloudProviders,
            provider_http_urls: nextProviderHttpUrls,
            http_url:
              normalizeProvider(prev?.provider) === providerId
                ? resolvePrimaryProviderHttpUrl(
                    {
                      ...(prev || {}),
                      cloud_fallback_providers: nextCloudProviders,
                      provider_http_urls: nextProviderHttpUrls,
                    },
                    providerId,
                  )
                : prev?.http_url || "",
          };
        });
      },
    [clearCloudProviderCheck, resolvePrimaryProviderHttpUrl],
  );

  const handleCloudProviderClearToggle = useCallback((providerId) => (event) => {
    const checked = Boolean(event.target.checked);
    clearCloudProviderCheck(providerId);
    setForm((prev) => {
      const currentProvider = prev?.cloud_fallback_providers?.[providerId] || {};
      return {
        ...(prev || {}),
        cloud_fallback_providers: {
          ...(prev?.cloud_fallback_providers || {}),
          [providerId]: {
            ...currentProvider,
            clear_api_key: checked,
            ...(checked ? { api_key: "" } : {}),
          },
        },
      };
    });
  }, [clearCloudProviderCheck]);

  const handleFallbackPriorityMove = useCallback((index, direction) => {
    setForm((prev) => {
      const currentOrder = normalizeLiveFallbackPriority(prev?.live_fallback_priority);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= currentOrder.length) {
        return prev;
      }

      const nextOrder = [...currentOrder];
      [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];

      return {
        ...(prev || {}),
        live_fallback_priority: nextOrder,
      };
    });
  }, []);

  return {
    cloudProviderChecks,
    error,
    feedback,
    form,
    handleChange,
    handleCloudFallbackFlagChange,
    handleCloudProviderClearToggle,
    handleCloudProviderFieldChange,
    handleCloudProviderTest,
    handleFallbackPriorityMove,
    handleProviderHttpUrlChange,
    handleProviderUrlChange,
    handleSave,
    loading,
    reload: load,
    saving,
    settings,
  };
}
