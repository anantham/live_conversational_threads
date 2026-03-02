import PropTypes from "prop-types";

import UploadTranscriptPreview from "./UploadTranscriptPreview";

const clampProgress = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

/**
 * Format backend string for display.
 * e.g., "local_whisperx" -> "Local", "modal_qwen3-32b" -> "Modal", "openrouter_gemini" -> "OpenRouter"
 */
const formatBackend = (backend) => {
  if (!backend) return null;
  const lower = backend.toLowerCase();
  if (lower.startsWith("modal")) return "Modal";
  if (lower.startsWith("openrouter") || lower.includes("openrouter")) return "OpenRouter";
  return "Local";
};

export default function UploadProgressPanel({
  etaText,
  isProcessing,
  liveTranscriptLines,
  llmBackend,
  progress,
  sttBackend,
  statusText,
}) {
  if (!(statusText || isProcessing)) return null;

  const sttLabel = formatBackend(sttBackend);
  const llmLabel = formatBackend(llmBackend);

  return (
    <div className="hidden md:block min-w-[180px] max-w-[260px]">
      <p className="text-[11px] text-gray-500 truncate">{statusText || "Processing..."}</p>
      {etaText && <p className="text-[10px] text-gray-400">{etaText}</p>}
      {/* Backend indicators */}
      {(sttLabel || llmLabel) && (
        <div className="flex items-center gap-2 mt-0.5 text-[9px] text-gray-400">
          {sttLabel && (
            <span className={
              sttLabel === "Modal" ? "text-yellow-600" :
              sttLabel === "OpenRouter" ? "text-blue-600" :
              "text-green-600"
            }>
              STT: {sttLabel}
            </span>
          )}
          {llmLabel && (
            <span className={
              llmLabel === "Modal" ? "text-yellow-600" :
              llmLabel === "OpenRouter" ? "text-blue-600" :
              "text-green-600"
            }>
              LLM: {llmLabel}
            </span>
          )}
        </div>
      )}
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
  llmBackend: PropTypes.string,
  progress: PropTypes.number.isRequired,
  sttBackend: PropTypes.string,
  statusText: PropTypes.string,
};
