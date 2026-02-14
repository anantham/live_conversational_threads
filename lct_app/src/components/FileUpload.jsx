import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Upload, X } from "lucide-react";

import { API_BASE_URL } from "../services/apiClient";

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

const clampProgress = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

function parseEventBlock(block) {
  let eventName = "message";
  const dataLines = [];
  const lines = block
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.length > 0);
  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim() || "message";
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  });
  if (dataLines.length === 0) return null;
  try {
    return { eventName, payload: JSON.parse(dataLines.join("\n")) };
  } catch (error) {
    console.warn("[FileUpload] Failed to parse SSE payload:", error);
    return null;
  }
}

export default function FileUpload({
  onDataReceived,
  onChunksReceived,
  setConversationId,
  setFileName,
  setMessage,
}) {
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");

  const clearLocalState = () => {
    setIsProcessing(false);
    setProgress(0);
  };

  const cancelUpload = () => {
    abortRef.current?.abort();
  };

  const processFile = async (file) => {
    if (!file || isProcessing) return;

    const nextConversationId = crypto.randomUUID();
    setConversationId?.(nextConversationId);
    setFileName?.(file.name.replace(/\.[^.]+$/, ""));
    onDataReceived?.([]);
    onChunksReceived?.({});
    setMessage?.("");

    setIsProcessing(true);
    setProgress(0.02);
    setStatusText(`Uploading ${file.name}...`);
    const abortController = new AbortController();
    abortRef.current = abortController;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("conversation_id", nextConversationId);

    try {
      const response = await fetch(`${API_BASE_URL}/api/import/process-file`, {
        method: "POST",
        body: formData,
        signal: abortController.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Upload failed (${response.status})`);
      }
      if (!response.body) {
        throw new Error("No stream body returned from process-file endpoint.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        streamBuffer += decoder.decode(value, { stream: true });

        let boundaryIndex = streamBuffer.indexOf("\n\n");
        while (boundaryIndex !== -1) {
          const block = streamBuffer.slice(0, boundaryIndex);
          streamBuffer = streamBuffer.slice(boundaryIndex + 2);
          const parsed = parseEventBlock(block);
          if (parsed) {
            const { eventName, payload } = parsed;
            if (eventName === "status") {
              setStatusText(payload.message || "Processing...");
              if (payload.progress != null) {
                setProgress(clampProgress(payload.progress));
              }
            }
            if (eventName === "transcript") {
              const index = Number(payload.index || 0);
              const total = Number(payload.total || 0);
              if (index > 0 && total > 0) {
                setStatusText(`Analyzing chunk ${index}/${total}...`);
                const ratio = 0.55 + (index / total) * 0.35;
                setProgress(clampProgress(ratio));
              }
            }
            if (eventName === "graph") {
              if (payload.type === "existing_json") {
                onDataReceived?.(payload.data);
              } else if (payload.type === "chunk_dict") {
                onChunksReceived?.(payload.data);
              }
            }
            if (eventName === "done") {
              setProgress(1);
              setStatusText(`Done: ${payload.node_count || 0} nodes`);
              setMessage?.(
                `Bulk upload complete (${payload.node_count || 0} nodes, ${payload.chunk_count || 0} chunks).`
              );
            }
            if (eventName === "error") {
              throw new Error(payload.message || "Bulk upload failed.");
            }
          }
          boundaryIndex = streamBuffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatusText("Upload canceled.");
        setMessage?.("Bulk upload canceled.");
      } else {
        const message = error?.message || "Bulk upload failed.";
        setStatusText(message);
        setMessage?.(message);
      }
    } finally {
      abortRef.current = null;
      clearLocalState();
      window.setTimeout(() => setStatusText(""), 3000);
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    await processFile(file);
  };

  return (
    <div className="flex items-center gap-2">
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

      {(statusText || isProcessing) && (
        <div className="hidden md:block min-w-[180px] max-w-[260px]">
          <p className="text-[11px] text-gray-500 truncate">{statusText || "Processing..."}</p>
          <div className="mt-1 h-1 rounded-full bg-gray-200">
            <div
              className="h-1 rounded-full bg-gray-500 transition-all duration-200"
              style={{ width: `${Math.round(clampProgress(progress) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

FileUpload.propTypes = {
  onDataReceived: PropTypes.func,
  onChunksReceived: PropTypes.func,
  setConversationId: PropTypes.func,
  setFileName: PropTypes.func,
  setMessage: PropTypes.func,
};
