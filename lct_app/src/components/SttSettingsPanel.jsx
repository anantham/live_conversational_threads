import { useState, useEffect } from "react";

import { getSttSettings, updateSttSettings } from "../services/sttSettingsApi";

export default function SttSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSttSettings();
      setSettings(data);
      setForm(data);
    } catch (err) {
      console.error("Unable to load STT settings:", err);
      setError("Unable to load STT configuration.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSttSettings(form);
      setSettings(updated);
      setForm(updated);
    } catch (err) {
      console.error("Failed to save STT settings:", err);
      setError("Unable to persist STT settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mt-6 text-sm text-gray-500">
        Loading STT settings…
      </div>
    );
  }

  return (
    <section className="bg-white rounded-lg shadow-lg p-6 mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">STT Settings</h2>
          <p className="text-sm text-gray-500">
            Text is streamed to the backend by default. Opt in to persist audio for later reprocessing.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm text-blue-600 hover:text-blue-800"
          type="button"
        >
          {loading ? "Refreshing…" : "Reload"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm text-gray-700 space-y-1">
          <span>STT Provider</span>
          <input
            type="text"
            value={form?.provider || ""}
            onChange={handleChange("provider")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Provider WebSocket URL</span>
          <input
            type="text"
            value={form?.ws_url || ""}
            onChange={handleChange("ws_url")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Chunk Endpoint</span>
          <input
            type="text"
            value={form?.chunk_endpoint || ""}
            onChange={handleChange("chunk_endpoint")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="text-sm text-gray-700 space-y-1">
          <span>Finalize Endpoint</span>
          <input
            type="text"
            value={form?.complete_endpoint || ""}
            onChange={handleChange("complete_endpoint")}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
          />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center space-x-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={Boolean(form?.store_audio)}
            onChange={handleChange("store_audio")}
            className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Store audio chunks (opt-in)</span>
        </label>
        <button
          onClick={handleSave}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition disabled:opacity-60"
          disabled={saving}
          type="button"
        >
          {saving ? "Saving…" : "Save STT Settings"}
        </button>
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        <p>Retention: {settings?.retention || "forever (default)"}.</p>
        <p>
          Audio download token: <code>{settings?.download_token || "not configured"}</code>
        </p>
      </div>
    </section>
  );
}
