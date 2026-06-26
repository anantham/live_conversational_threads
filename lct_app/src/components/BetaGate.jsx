import PropTypes from "prop-types";

const MESSAGES = {
  unreachable: {
    badge: "Not on network",
    badgeClass: "bg-gray-100 text-gray-600",
    heading: "Backend not reachable",
    body: "The backend runs on a private Tailscale network. Connect to Tailscale and try again.",
  },
  offline: {
    badge: "Service unavailable",
    badgeClass: "bg-red-50 text-red-700",
    heading: "Backend temporarily down",
    body: "The backend is reachable but not responding right now. It may be restarting — try again in a moment.",
  },
};

const FALLBACK = {
  badge: "Private beta",
  badgeClass: "bg-amber-100 text-amber-800",
  heading: "Live Conversational Threads",
  body: "This app’s backend runs on a private network and isn’t reachable from your connection right now.",
};

/**
 * Shown when the backend can't be reached. Distinguishes between
 * "off Tailscale" (timeout) and "backend process down" (fast failure)
 * so the viewer knows what action to take.
 */
export default function BetaGate({ reason, onRetry }) {
  const msg = MESSAGES[reason] ?? FALLBACK;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-800">
          Live Conversational Threads
        </h1>
        <div
          className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${msg.badgeClass}`}
        >
          {msg.badge}
        </div>
        <p className="mt-5 text-sm font-medium text-gray-800">{msg.heading}</p>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">{msg.body}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded border border-gray-300 px-4 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-100"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

BetaGate.propTypes = {
  reason: PropTypes.oneOf(["offline", "unreachable"]),
  onRetry: PropTypes.func,
};
