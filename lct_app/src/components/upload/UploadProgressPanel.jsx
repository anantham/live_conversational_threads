import PropTypes from "prop-types";

import UploadTranscriptPreview from "./UploadTranscriptPreview";

const clampProgress = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

/**
 * Format milliseconds as human-readable duration string.
 */
const formatDuration = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

/**
 * Get tooltip text for backend type
 */
const getBackendTooltip = (type, backend) => {
  if (!backend) return "";
  const label = formatBackend(backend);
  const model = backend.replace(/^(local_|modal_|openrouter_)/i, "");

  if (type === "stt") {
    if (label === "Local") return `WhisperX on local GPU (${model || "whisperx"})`;
    if (label === "Modal") return `WhisperX on Modal cloud (${model || "whisperx"})`;
    return `STT via ${label}`;
  }

  if (type === "llm") {
    if (label === "Local") return `LLM on local GPU (${model || "local model"})`;
    if (label === "Modal") return `LLM on Modal cloud (${model || "qwen3-32b"})`;
    if (label === "OpenRouter") return `LLM via OpenRouter API (${model || "gemini-3-flash"})`;
    return `LLM via ${label}`;
  }

  return backend;
};

export default function UploadProgressPanel({
  audioDurationMs,
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
  const durationStr = formatDuration(audioDurationMs);

  return (
    <div className="hidden md:block min-w-[180px] max-w-[260px]">
      <p className="text-[11px] text-gray-500 truncate">{statusText || "Processing..."}</p>
      {/* Duration and ETA row */}
      {(durationStr || etaText) && (
        <p className="text-[10px] text-gray-400">
          {durationStr && <span title="Audio file duration">Duration: {durationStr}</span>}
          {durationStr && etaText && <span className="mx-1">•</span>}
          {etaText && <span>{etaText}</span>}
        </p>
      )}
      {/* Backend indicators */}
      {(sttLabel || llmLabel) && (
        <div className="flex items-center gap-2 mt-0.5 text-[9px] text-gray-400">
          {sttLabel && (
            <span
              title={getBackendTooltip("stt", sttBackend)}
              className={`cursor-help ${
                sttLabel === "Modal" ? "text-yellow-600" :
                sttLabel === "OpenRouter" ? "text-blue-600" :
                "text-green-600"
              }`}
            >
              STT: {sttLabel}
            </span>
          )}
          {llmLabel && (
            <span
              title={getBackendTooltip("llm", llmBackend)}
              className={`cursor-help ${
                llmLabel === "Modal" ? "text-yellow-600" :
                llmLabel === "OpenRouter" ? "text-blue-600" :
                "text-green-600"
              }`}
            >
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
  audioDurationMs: PropTypes.number,
  etaText: PropTypes.string,
  isProcessing: PropTypes.bool.isRequired,
  liveTranscriptLines: PropTypes.arrayOf(PropTypes.string),
  llmBackend: PropTypes.string,
  progress: PropTypes.number.isRequired,
  sttBackend: PropTypes.string,
  statusText: PropTypes.string,
};
