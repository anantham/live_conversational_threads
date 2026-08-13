import PropTypes from "prop-types";

import { PILL_STYLES } from "./statusPillStyles";

export default function StatusPill({ details, label, state, summary }) {
  const styles = PILL_STYLES[state] || PILL_STYLES.loading;

  return (
    <div className="group relative">
      <button
        type="button"
        className={`inline-flex cursor-help items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-sm transition ${styles.pill}`}
        aria-label={`${label}: ${summary}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
        <span>{label}</span>
      </button>

      <div className="pointer-events-none fixed inset-x-3 bottom-16 z-20 translate-y-2 rounded-2xl border border-slate-200 bg-white/95 p-3 text-left opacity-0 shadow-xl backdrop-blur transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-3 sm:w-[min(22rem,calc(100vw-3rem))]">
        <p className="text-[11px] font-semibold text-slate-800">{summary}</p>
        <div className="mt-2 space-y-1.5">
          {details.map((detail, i) => (
            <div key={`${label}-${detail.label}-${i}`} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="text-slate-500">{detail.label}</span>
              <span className="max-w-[12rem] text-right font-medium text-slate-700">
                {detail.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

StatusPill.propTypes = {
  details: PropTypes.arrayOf(PropTypes.shape({
    label: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired,
  })).isRequired,
  label: PropTypes.string.isRequired,
  state: PropTypes.oneOf(["configured", "healthy", "loading", "unavailable"]).isRequired,
  summary: PropTypes.string.isRequired,
};
