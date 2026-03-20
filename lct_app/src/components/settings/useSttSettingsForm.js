import { useCallback, useEffect, useState } from "react";

import { getSttSettings, updateSttSettings } from "../../services/sttSettingsApi";
import {
  normalizeLiveFallbackPriority,
  normalizeProvider,
  normalizeSttSettings,
} from "../audio/sttUtils";

export default function useSttSettingsForm() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSttSettings();
      const normalized = normalizeSttSettings(data);
      setSettings(normalized);
      setForm(normalized);
    } catch (err) {
      console.error("Unable to load STT settings:", err);
      const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
      setError(isNetworkError ? "Backend unavailable" : "Unable to load STT configuration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const normalized = normalizeSttSettings(form);
      const payload = {
        ...normalized,
        ws_url: normalized.provider_urls?.[normalized.provider] || normalized.ws_url,
      };
      const updated = await updateSttSettings(payload);
      const updatedNormalized = normalizeSttSettings(updated);
      setSettings(updatedNormalized);
      setForm(updatedNormalized);
    } catch (err) {
      console.error("Failed to save STT settings:", err);
      const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
      setError(isNetworkError ? "Backend unavailable" : "Unable to persist STT settings.");
    } finally {
      setSaving(false);
    }
  }, [form]);

  const handleChange = useCallback((key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => {
      const next = { ...(prev || {}), [key]: value };
      if (key === "provider") {
        const normalizedProvider = normalizeProvider(value);
        next.provider = normalizedProvider;
        next.ws_url = next.provider_urls?.[normalizedProvider] || "";
        next.http_url = next.provider_http_urls?.[normalizedProvider] || "";
      }
      return next;
    });
  }, []);

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
          ? value
          : prev?.http_url || "",
    }));
  }, []);

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
        setForm((prev) => {
          const currentProvider = prev?.cloud_fallback_providers?.[providerId] || {};
          return {
            ...(prev || {}),
            cloud_fallback_providers: {
              ...(prev?.cloud_fallback_providers || {}),
              [providerId]: {
                ...currentProvider,
                [field]: value,
                ...(field === "api_key" && String(value || "").trim()
                  ? { clear_api_key: false }
                  : {}),
              },
            },
          };
        });
      },
    [],
  );

  const handleCloudProviderClearToggle = useCallback((providerId) => (event) => {
    const checked = Boolean(event.target.checked);
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
  }, []);

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
    error,
    form,
    handleChange,
    handleCloudFallbackFlagChange,
    handleCloudProviderClearToggle,
    handleCloudProviderFieldChange,
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
