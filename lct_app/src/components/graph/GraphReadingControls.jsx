import PropTypes from "prop-types";

import TooltipButton from "../TooltipButton";

export default function GraphReadingControls({ navigationScope, readingIndex, readingPathLength, onPrevious, onNext, inline = false }) {
  const inThread = navigationScope === "selected thread";
  const previousDisabled = readingIndex === 0;
  const nextDisabled = readingIndex === readingPathLength - 1;
  const previousTooltip = inThread
    ? "Previous moment in this thread. Follows the thread’s moments. Left arrow key."
    : "Previous moment in this conversation. Follows the conversation order. Left arrow key.";
  const nextTooltip = inThread
    ? "Next moment in this thread. Follows the thread’s moments. Right arrow key."
    : "Next moment in this conversation. Follows the conversation order. Right arrow key.";

  return (
    <nav aria-label={`${inThread ? "Selected thread" : "Conversation"} reading controls`} className={`${inline ? "max-w-full flex-wrap justify-center" : "absolute bottom-3 left-1/2 z-50 -translate-x-1/2"} flex items-center gap-2 rounded-lg border border-slate-200 bg-white/95 p-1.5 text-xs text-slate-700 shadow-sm`}>
      <TooltipButton
        type="button"
        aria-label={`Previous moment in ${navigationScope}`}
        disabled={previousDisabled}
        onClick={onPrevious}
        className="min-h-11 rounded px-2 hover:bg-slate-100 disabled:opacity-40"
        tooltip={`${previousTooltip}${previousDisabled ? " You’re at the first moment." : ""}`}
        placement="top"
      ><span aria-hidden="true">←</span><span className={inline ? "hidden sm:inline" : undefined}> Previous</span></TooltipButton>
      <span aria-live="polite" className="min-w-12 text-center tabular-nums">{readingIndex < 0 ? `${readingPathLength} moments` : `${readingIndex + 1} of ${readingPathLength}`}</span>
      <TooltipButton
        type="button"
        aria-label={`Next moment in ${navigationScope}`}
        disabled={nextDisabled}
        onClick={onNext}
        className="min-h-11 rounded px-2 hover:bg-slate-100 disabled:opacity-40"
        tooltip={`${nextTooltip}${nextDisabled ? " You’re at the last moment." : ""}`}
        placement="top"
      ><span className={inline ? "hidden sm:inline" : undefined}>Next </span><span aria-hidden="true">→</span></TooltipButton>
    </nav>
  );
}

GraphReadingControls.propTypes = {
  navigationScope: PropTypes.string.isRequired,
  readingIndex: PropTypes.number.isRequired,
  readingPathLength: PropTypes.number.isRequired,
  onPrevious: PropTypes.func.isRequired,
  onNext: PropTypes.func.isRequired,
  inline: PropTypes.bool,
};
