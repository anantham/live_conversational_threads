import PropTypes from "prop-types";

import Sparkline from "./Sparkline";
import useConnectionHealth from "./useConnectionHealth";

const QUALITY = {
  stable: { label: "stable", cls: "text-emerald-600", dot: "bg-emerald-500" },
  jittery: { label: "jittery", cls: "text-amber-600", dot: "bg-amber-400" },
  poor: { label: "unstable", cls: "text-rose-600", dot: "bg-rose-500" },
  unknown: { label: "checking…", cls: "text-gray-400", dot: "bg-gray-300" },
};

// Live link-health panel for the settings Overview. Shows current ping, jitter,
// and drop count with a rolling sparkline so the user can read stability over
// the last ~10 minutes, not just a single ping.
export default function ConnectionMeter({ enabled = true, label = "M5 backend" }) {
  const health = useConnectionHealth({ enabled });
  const q = QUALITY[health.quality] || QUALITY.unknown;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold text-gray-900">Connection · {label}</span>{" "}
          <span className="text-gray-400">Tailscale</span>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${q.cls}`}>
          <span className={`h-2 w-2 rounded-full ${q.dot}`} aria-hidden="true" />
          {q.label}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span>
          <span className="text-xl font-semibold text-gray-900">
            {health.now == null ? "—" : health.now}
          </span>{" "}
          <span className="text-xs text-gray-400">ms now</span>
        </span>
        <span>
          <span className="text-xl font-semibold text-gray-900">±{health.jitter}</span>{" "}
          <span className="text-xs text-gray-400">ms jitter</span>
        </span>
        <span>
          <span className="text-xl font-semibold text-gray-900">{health.drops}</span>{" "}
          <span className="text-xs text-gray-400">
            drops / {health.total} pings
          </span>
        </span>
        {health.total > 0 ? <span className="text-xs text-gray-400">last ~10 min</span> : null}
      </div>

      <Sparkline values={health.series} className="mt-2.5" />
    </div>
  );
}

ConnectionMeter.propTypes = {
  enabled: PropTypes.bool,
  label: PropTypes.string,
};
