import { useCallback, useEffect, useState } from "react";

import { getAutostartOnNew, setAutostartOnNew } from "../../utils/homeBehavior";

// Per-device preference: should Home's "New" button start recording on
// arrival, or land the user on /new in idle state? Stored in localStorage
// via utils/homeBehavior.js; Home reads the same helper to decide where
// to navigate.
export default function HomeBehaviorCard() {
  const [autostart, setAutostart] = useState(true);

  useEffect(() => {
    setAutostart(getAutostartOnNew());
  }, []);

  const handleToggle = useCallback(() => {
    setAutostart((prev) => {
      const next = !prev;
      setAutostartOnNew(next);
      return next;
    });
  }, []);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-800">Home → New behavior</h3>
          <p className="mt-1 text-xs text-gray-600">
            {autostart
              ? "Home's New button starts recording immediately (→ /new?autostart=true)."
              : "Home's New button opens the live page without starting recording (→ /new). Use this if you usually upload files instead of recording live."}
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          role="switch"
          aria-checked={autostart}
          aria-label="Autostart recording on New"
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-slate-300 ${
            autostart ? "bg-slate-800" : "bg-gray-300"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              autostart ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
      <p className="mt-3 text-[11px] text-gray-400">
        Stored per device. Doesn&apos;t sync across browsers.
      </p>
    </div>
  );
}
