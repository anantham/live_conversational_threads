import { useRef } from "react";
import PropTypes from "prop-types";
import { Upload, X } from "lucide-react";

import UploadProgressPanel from "./upload/UploadProgressPanel";
import { useUpload } from "../contexts/UploadContext";

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
  ".zip",
].join(",");

export default function FileUpload() {
  const inputRef = useRef(null);
  const {
    audioDurationMs,
    cancelUpload,
    etaText,
    fallbackToast,
    resumeToast,
    isProcessing,
    liveTranscriptLines,
    llmBackend,
    processFile,
    progress,
    sttBackend,
    statusText,
  } = useUpload();

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    await processFile(file);
  };

  return (
    <div className="relative flex items-center gap-2">
      {isProcessing ? (
        <button
          type="button"
          onClick={cancelUpload}
          className="relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none bg-red-50 text-red-500 hover:bg-red-100"
          aria-label="Cancel upload"
          title="Cancel upload"
        >
          <X size={18} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none bg-gray-100 text-gray-500 hover:bg-gray-200"
          aria-label="Upload file for bulk processing"
        >
          <Upload size={18} />
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

      {resumeToast && (
        <div className="absolute bottom-full left-0 right-0 mb-2 pointer-events-none">
          <div className="mx-auto max-w-md rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 shadow-sm">
            &#x21bb; {resumeToast}
          </div>
        </div>
      )}
    </div>
  );
}

FileUpload.propTypes = {};
