import PropTypes from "prop-types";

import UploadTranscriptPreview from "./UploadTranscriptPreview";

const clampProgress = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

export default function UploadProgressPanel({
  etaText,
  isProcessing,
  liveTranscriptLines,
  progress,
  statusText,
}) {
  if (!(statusText || isProcessing)) return null;

  return (
    <div className="hidden md:block min-w-[180px] max-w-[260px]">
      <p className="text-[11px] text-gray-500 truncate">{statusText || "Processing..."}</p>
      {etaText && <p className="text-[10px] text-gray-400">{etaText}</p>}
      <div className="mt-1 h-1 rounded-full bg-gray-200">
        <div
          className="h-1 rounded-full bg-gray-500 transition-all duration-200"
          style={{ width: `${Math.round(clampProgress(progress) * 100)}%` }}
        />
      </div>
      <UploadTranscriptPreview lines={liveTranscriptLines} />
    </div>
  );
}

UploadProgressPanel.propTypes = {
  etaText: PropTypes.string,
  isProcessing: PropTypes.bool.isRequired,
  liveTranscriptLines: PropTypes.arrayOf(PropTypes.string),
  progress: PropTypes.number.isRequired,
  statusText: PropTypes.string,
};
