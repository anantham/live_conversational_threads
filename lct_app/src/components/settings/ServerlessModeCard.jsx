import { useState } from "react";

export default function ServerlessModeCard() {
  const [key, setKey] = useState(() => localStorage.getItem("lct_serverless_key") || "");
  const [isEnabled, setIsEnabled] = useState(() => localStorage.getItem("lct_serverless_mode_enabled") === "true");

  const handleSave = () => {
    if (key.trim()) {
      localStorage.setItem("lct_serverless_key", key.trim());
      localStorage.setItem("lct_serverless_mode_enabled", "true");
    } else {
      localStorage.removeItem("lct_serverless_mode_enabled");
    }
    // Reload to re-initialize App.jsx providers and routing state cleanly
    window.location.reload();
  };

  const handleToggleOff = () => {
    localStorage.removeItem("lct_serverless_mode_enabled");
    // We intentionally LEAVE the lct_serverless_key in localStorage so they don't have to retype it!
    window.location.reload();
  };

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50/50 px-4 py-4 shadow-sm">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-blue-900">
          Serverless Mode (BYOK)
        </h3>
        <p className="mt-1 text-xs text-blue-800">
          When enabled, the app bypasses the Tailscale backend completely. Audio and LLM requests are routed securely via Vercel Edge functions directly to OpenAI, and all data is saved locally to your browser.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-proj-..."
          className="w-full max-w-sm rounded-md border border-blue-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        />
        <button
          onClick={handleSave}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition"
        >
          {isEnabled ? "Update Key" : "Enable Serverless"}
        </button>
        {isEnabled && (
          <button
            onClick={handleToggleOff}
            className="rounded-md border border-blue-200 px-4 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition"
          >
            Disable & Use Tailnet
          </button>
        )}
      </div>
      {isEnabled && (
        <p className="mt-2 text-[11px] font-medium text-blue-600 uppercase tracking-wide">
          Status: Serverless Mode Active
        </p>
      )}
    </div>
  );
}
