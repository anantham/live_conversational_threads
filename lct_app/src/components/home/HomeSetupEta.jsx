import PropTypes from "prop-types";

export default function HomeSetupEta({ eta }) {
  const progressPercent = Math.round(Math.max(0, Math.min(1, eta.progress)) * 100);

  return (
    <div className="mb-2 w-[min(34rem,calc(100vw-4rem))]" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="font-medium text-slate-600">Checking live setup…</span>
        <span className={`tabular-nums ${eta.isOverrun ? "text-amber-700" : "text-slate-500"}`}>
          {eta.remainingText}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/80"
        role="progressbar"
        aria-label="Live setup check progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progressPercent}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            eta.isOverrun ? "bg-amber-400" : "bg-slate-500"
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{eta.basisText}</p>
    </div>
  );
}

HomeSetupEta.propTypes = {
  eta: PropTypes.shape({
    basisText: PropTypes.string.isRequired,
    isOverrun: PropTypes.bool.isRequired,
    progress: PropTypes.number.isRequired,
    remainingText: PropTypes.string.isRequired,
  }).isRequired,
};
