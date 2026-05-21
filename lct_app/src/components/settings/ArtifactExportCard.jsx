import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getArtifactExportSettings,
  testArtifactExportSettings,
  updateArtifactExportSettings,
} from "../../services/artifactSettingsApi";

function describeRequestError(err, fallbackMessage) {
  const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
  return isNetworkError ? "Backend unavailable" : fallbackMessage;
}

function buildSummary(settings) {
  if (!settings) return "Loading artifact export settings...";
  if (!settings.enabled) return "Auto-export off";
  const outputs = [];
  if (settings.write_canvas) outputs.push(".canvas");
  if (settings.write_transcript) outputs.push(".txt");
  const outputLabel = outputs.length ? outputs.join(" + ") : "no artifact types selected";
  const rootPath = settings.root_path || "folder not configured";
  const selfName = settings.self_name ? ` (self: ${settings.self_name})` : "";
  return `On for import completion → ${outputLabel} → ${rootPath}${selfName}`;
}

export default function ArtifactExportCard() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const summary = useMemo(() => buildSummary(form || settings), [form, settings]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getArtifactExportSettings();
      setSettings(data);
      setForm(data);
      setFeedback(null);
    } catch (err) {
      console.error("Unable to load artifact export settings:", err);
      setError(describeRequestError(err, "Unable to load artifact export settings."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCheckboxChange = useCallback((key) => (event) => {
    const checked = Boolean(event.target.checked);
    setForm((prev) => ({
      ...(prev || {}),
      [key]: checked,
    }));
  }, []);

  const handleTextChange = useCallback((key) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...(prev || {}),
      [key]: value,
    }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateArtifactExportSettings(form);
      setSettings(updated);
      setForm(updated);
      setFeedback({
        tone: "success",
        message: "Artifact export settings saved.",
      });
    } catch (err) {
      console.error("Failed to save artifact export settings:", err);
      setFeedback(null);
      setError(describeRequestError(err, "Unable to persist artifact export settings."));
    } finally {
      setSaving(false);
    }
  }, [form]);

  const handleTestWrite = useCallback(async () => {
    if (!form) return;
    setTesting(true);
    setError(null);
    try {
      const result = await testArtifactExportSettings(form);
      setFeedback({
        tone: "success",
        message: `Write test passed: ${result.resolved_root_path}`,
      });
    } catch (err) {
      console.error("Artifact export write test failed:", err);
      setFeedback(null);
      setError(describeRequestError(err, "Artifact export write test failed."));
    } finally {
      setTesting(false);
    }
  }, [form]);

  if (loading) {
    return (
      <div className="rounded-lg bg-white p-6 text-sm text-gray-500 shadow">
        Loading artifact export settings...
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-lg bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">Artifact Export</h2>
          <p className="mt-1 text-sm text-gray-500">
            Optionally write paired `.canvas` and `.txt` artifacts into your Obsidian folder
            after successful imports.
          </p>
          <p className="mt-2 text-xs text-gray-600">{summary}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            type="button"
          >
            Reload
          </button>
          <button
            onClick={handleTestWrite}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60"
            disabled={testing || saving}
            type="button"
          >
            {testing ? "Testing..." : "Test Write"}
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white transition hover:bg-blue-700 disabled:opacity-60"
            disabled={saving}
            type="button"
          >
            {saving ? "Saving..." : "Save Artifact Settings"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {feedback ? (
        <p
          className={`rounded px-3 py-2 text-xs ${
            feedback.tone === "success"
              ? "border border-green-200 bg-green-50 text-green-700"
              : "border border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {feedback.message}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.enabled)}
              onChange={handleCheckboxChange("enabled")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Enable automatic Obsidian export</span>
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={Boolean(form?.trigger_on_import_complete)}
              onChange={handleCheckboxChange("trigger_on_import_complete")}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
            <span>Write after import completes</span>
          </label>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              Auto-export: {form?.enabled ? "on" : "off"}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              Import trigger: {form?.trigger_on_import_complete ? "on" : "off"}
            </span>
          </div>
        </div>

        <div className="space-y-4">
          <label className="block space-y-1 text-sm text-gray-700">
            <span>Obsidian export folder</span>
            <input
              type="text"
              value={form?.root_path || ""}
              onChange={handleTextChange("root_path")}
              placeholder="/Users/aditya/.../Exocortex/Conversations/Anand"
              className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-500">
              Must be an absolute directory path on this machine.
            </span>
          </label>

          <label className="block space-y-1 text-sm text-gray-700">
            <span>Your name for participant routing</span>
            <input
              type="text"
              value={form?.self_name || ""}
              onChange={handleTextChange("self_name")}
              placeholder="Aditya"
              className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-500">
              If exactly one confirmed participant name differs from this, artifacts route into that participant folder.
              Otherwise they stay at the Conversations root.
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={Boolean(form?.write_canvas)}
                onChange={handleCheckboxChange("write_canvas")}
                className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
              />
              <span>Write `.canvas`</span>
            </label>

            <label className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={Boolean(form?.write_transcript)}
                onChange={handleCheckboxChange("write_transcript")}
                className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
              />
              <span>Write `.txt`</span>
            </label>

            <label className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={Boolean(form?.include_chunks)}
                onChange={handleCheckboxChange("include_chunks")}
                className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
              />
              <span>Include moments</span>
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}
