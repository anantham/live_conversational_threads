import { useEffect, useState } from "react";

import { apiFetch } from "../services/apiClient";
import { getLlmSettings } from "../services/llmSettingsApi";
import { getSttSettings, updateSttSettings } from "../services/sttSettingsApi";
import { STT_PROVIDER_OPTIONS, normalizeSttSettings } from "./audio/sttUtils";

export default function ActiveConfigSummary() {
  const [llmProviders, setLlmProviders] = useState([]);
  const [llmSettings, setLlmSettings] = useState(null);
  const [sttSettings, setSttSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [providersRes, llm, stt] = await Promise.all([
          apiFetch("/api/settings/llm/providers").then((r) => (r.ok ? r.json() : null)),
          getLlmSettings().catch(() => null),
          getSttSettings().catch(() => null),
        ]);
        setLlmProviders(providersRes?.providers || []);
        setLlmSettings(llm);
        if (stt) setSttSettings(normalizeSttSettings(stt));
      } catch (err) {
        console.error("ActiveConfigSummary: failed to load:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const activeLlmProvider = llmProviders.find((p) => p.enabled) || llmProviders[0];

  const handleLlmQuickSwitch = async (providerId) => {
    const idx = llmProviders.findIndex((p) => p.id === providerId);
    if (idx < 0) return;
    // Move selected provider to position 0
    const reordered = [...llmProviders];
    const [selected] = reordered.splice(idx, 1);
    selected.enabled = true;
    reordered.unshift(selected);

    setSaving("llm");
    try {
      const response = await apiFetch("/api/settings/llm/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: reordered }),
      });
      if (response.ok) {
        const data = await response.json();
        setLlmProviders(data.providers || reordered);
      }
    } catch (err) {
      console.error("Quick switch LLM failed:", err);
    } finally {
      setSaving(null);
    }
  };

  const handleSttQuickSwitch = async (newProvider) => {
    if (!sttSettings) return;
    setSaving("stt");
    try {
      const payload = {
        ...sttSettings,
        provider: newProvider,
        ws_url: sttSettings.provider_urls?.[newProvider] || "",
        http_url: sttSettings.provider_http_urls?.[newProvider] || "",
      };
      const updated = await updateSttSettings(payload);
      setSttSettings(normalizeSttSettings(updated));
    } catch (err) {
      console.error("Quick switch STT failed:", err);
    } finally {
      setSaving(null);
    }
  };

  const handleToggle = async (key) => {
    if (!sttSettings) return;
    const updated = { ...sttSettings, [key]: !sttSettings[key] };
    setSttSettings(updated);
    setSaving(key);
    try {
      const result = await updateSttSettings({
        ...updated,
        ws_url: updated.provider_urls?.[updated.provider] || updated.ws_url,
      });
      setSttSettings(normalizeSttSettings(result));
    } catch (err) {
      console.error(`Toggle ${key} failed:`, err);
      setSttSettings(sttSettings);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-4 mb-2 text-sm text-gray-400">
        Loading active configuration...
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-2 space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        {/* LLM status */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wide">LLM</p>
            <select
              value={activeLlmProvider?.id || ""}
              onChange={(e) => handleLlmQuickSwitch(e.target.value)}
              disabled={saving === "llm"}
              className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            >
              {llmProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id} — {p.model}
                </option>
              ))}
              {llmProviders.length === 0 && (
                <option value="">No providers configured</option>
              )}
            </select>
          </div>
          {llmSettings && (
            <span className="text-xs text-gray-400 pt-4 shrink-0">
              {llmSettings.mode === "online" ? "online" : "local"}
            </span>
          )}
        </div>

        {/* STT status */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Speech-to-Text</p>
            <select
              value={sttSettings?.provider || "whisper"}
              onChange={(e) => handleSttQuickSwitch(e.target.value)}
              disabled={saving === "stt"}
              className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            >
              {STT_PROVIDER_OPTIONS.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Policy toggles */}
      {sttSettings && (
        <div className="flex items-center gap-5 pt-1 border-t border-gray-100">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(sttSettings.local_only)}
              onChange={() => handleToggle("local_only")}
              disabled={saving === "local_only"}
              className="h-3.5 w-3.5 rounded text-blue-600"
            />
            Local-only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(sttSettings.store_audio)}
              onChange={() => handleToggle("store_audio")}
              disabled={saving === "store_audio"}
              className="h-3.5 w-3.5 rounded text-blue-600"
            />
            Store audio
          </label>
        </div>
      )}
    </div>
  );
}
