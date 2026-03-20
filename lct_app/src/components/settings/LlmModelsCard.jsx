import { useCallback, useEffect, useState } from "react";

import { getLlmSettings } from "../../services/llmSettingsApi";
import LlmSettingsPanel from "../LlmSettingsPanel";
import { buildLlmModelsSummary } from "./settingsSummary";

export default function LlmModelsCard() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("Loading graph model settings...");
  const [error, setError] = useState(null);

  const refreshSummary = useCallback(async () => {
    try {
      const settings = await getLlmSettings();
      setSummary(buildLlmModelsSummary(settings));
      setError(null);
    } catch (err) {
      console.error("Unable to load graph model summary:", err);
      setSummary("Unable to load graph model settings");
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  return (
    <section className="rounded-lg bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">Models & Embeddings</h2>
          <p className="mt-1 text-sm text-gray-500">
            Default chat and embedding models used after routing chooses a provider.
          </p>
          <p className="mt-2 text-xs text-gray-600">{summary}</p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <button
          onClick={() => setOpen((current) => !current)}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          type="button"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 border-t border-gray-200 pt-4">
          <LlmSettingsPanel embedded onSaved={refreshSummary} />
        </div>
      ) : null}
    </section>
  );
}
