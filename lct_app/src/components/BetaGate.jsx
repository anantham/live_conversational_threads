import PropTypes from "prop-types";

/**
 * Shown when the backend can't be reached. The frontend is deployed
 * publicly (Vercel) but the backend is served over a private Tailscale
 * network, so off-network visitors can load the page but not the API.
 * Rather than a broken app full of fetch errors, give them a friendly
 * private-beta message.
 */
export default function BetaGate({ onRetry }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-800">
          Live Conversational Threads
        </h1>
        <div className="mt-2 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-800">
          Private beta
        </div>
        <p className="mt-5 text-sm leading-relaxed text-gray-600">
          This app is in private beta. Its backend runs on a private network,
          so it isn&apos;t reachable from your connection right now.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-gray-600">
          If you&apos;d like to try it, ask{" "}
          <span className="font-medium text-gray-800">Aditya</span> to add you.
        </p>
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
  onRetry: PropTypes.func,
};
