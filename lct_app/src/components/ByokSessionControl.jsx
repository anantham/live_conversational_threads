import { useMemo } from "react";

import { useByok } from "../contexts/byokContext";

function formatExpiry(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ByokSessionControl() {
  const {
    apiKey,
    clearByok,
    error,
    hasApiKey,
    isSessionReady,
    refreshSession,
    sessionExpiresAt,
    setApiKey,
    status,
  } = useByok();

  const helperText = useMemo(() => {
    if (error) return error;
    if (status === "connecting") return "Validating key and creating a short-lived STT session...";
    if (isSessionReady) {
      const expiry = formatExpiry(sessionExpiresAt);
      return expiry
        ? `STT BYOK ready until ${expiry}. Graph generation still uses the server-side LLM.`
        : "STT BYOK ready. Graph generation still uses the server-side LLM.";
    }
    if (hasApiKey) {
      return "Session-only. The raw key stays in browser memory and is only sent to mint a short-lived STT token.";
    }
    return "Optional BYOK for live and uploaded audio. Leave blank to use the hosted trial path.";
  }, [error, hasApiKey, isSessionReady, sessionExpiresAt, status]);

  return (
    <div className="min-w-0 flex-1 max-w-md rounded-2xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            BYOK STT
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="OpenAI API key (session only)"
            className="mt-1 w-full bg-transparent text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none"
            autoComplete="off"
            spellCheck="false"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            void refreshSession().catch(() => {});
          }}
          disabled={!hasApiKey || status === "connecting"}
          className="rounded-full border border-gray-200 px-3 py-1.5 text-[11px] font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSessionReady ? "Refresh" : "Connect"}
        </button>
        {hasApiKey && (
          <button
            type="button"
            onClick={clearByok}
            className="rounded-full px-2 py-1.5 text-[11px] font-medium text-gray-400 transition hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>
      <p className={`mt-1 text-[11px] ${error ? "text-red-600" : "text-gray-500"}`}>
        {helperText}
      </p>
    </div>
  );
}
