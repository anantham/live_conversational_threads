import { useRef } from "react";
import PropTypes from "prop-types";
import { Upload, X } from "lucide-react";

import UploadProgressPanel from "./upload/UploadProgressPanel";
import useFileUploadStream from "./upload/useFileUploadStream";

const ACCEPTED_FILE_TYPES = [
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
  ".webm",
  ".mp4",
  ".txt",
  ".text",
  ".md",
  ".log",
  ".vtt",
  ".srt",
  ".pdf",
].join(",");

export default function FileUpload({
  onDataReceived,
  onChunksReceived,
  onGraphPatchReceived,
  setConversationId,
  setFileName,
  setMessage,
}) {
  const inputRef = useRef(null);
  const {
    audioDurationMs,
    cancelUpload,
    etaText,
    fallbackToast,
    isProcessing,
    liveTranscriptLines,
    llmBackend,
    processFile,
    progress,
    sttBackend,
    statusText,
  } = useFileUploadStream({
    onDataReceived,
    onChunksReceived,
    onGraphPatchReceived,
    setConversationId,
    setFileName,
    setMessage,
  });

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    await processFile(file);
  };

  return (
    <div className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none bg-gray-100 text-gray-500 hover:bg-gray-200"
        aria-label="Upload file for bulk processing"
        disabled={isProcessing}
      >
        <Upload size={18} />
      </button>

      {isProcessing && (
        <button
          type="button"
          onClick={cancelUpload}
          className="w-8 h-8 rounded-full border border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300 transition"
          aria-label="Cancel upload"
          title="Cancel upload"
        >
          <X size={14} className="mx-auto" />
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileChange}
      />

      <UploadProgressPanel
        audioDurationMs={audioDurationMs}
        statusText={statusText}
        isProcessing={isProcessing}
        etaText={etaText}
        progress={progress}
        liveTranscriptLines={liveTranscriptLines}
        sttBackend={sttBackend}
        llmBackend={llmBackend}
      />

      {fallbackToast && (
        <div className="absolute bottom-full left-0 right-0 mb-2 pointer-events-none">
          <div className="mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-sm">
            {fallbackToast}
          </div>
        </div>
      )}
    </div>
  );
}

FileUpload.propTypes = {
  onDataReceived: PropTypes.func,
  onChunksReceived: PropTypes.func,
  onGraphPatchReceived: PropTypes.func,
  setConversationId: PropTypes.func,
  setFileName: PropTypes.func,
  setMessage: PropTypes.func,
};
