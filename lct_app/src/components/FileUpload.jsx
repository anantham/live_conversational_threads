import { useEffect, useRef, useState } from "react";
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
const LIVE_STT_LINES_MAX = 8;

const clampProgress = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

const formatDuration = (milliseconds) => {
  const ms = Number(milliseconds);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const normalizeTranscriptLine = (value) => String(value || "").replace(/\s+/g, " ").trim();

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
  const fallbackNoticeKeyRef = useRef("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [fallbackToast, setFallbackToast] = useState("");
  const [etaText, setEtaText] = useState("");
  const [liveTranscriptLines, setLiveTranscriptLines] = useState([]);

  useEffect(() => {
    if (!fallbackToast) return undefined;
    const timeoutId = window.setTimeout(() => setFallbackToast(""), 8000);
    return () => window.clearTimeout(timeoutId);
  }, [fallbackToast]);

  const clearLocalState = () => {
    setIsProcessing(false);
    setProgress(0);
    setEtaText("");
    setLiveTranscriptLines([]);
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
    setFallbackToast("");
    setEtaText("");
    setLiveTranscriptLines([]);
    fallbackNoticeKeyRef.current = "";
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
              const stage = String(payload.stage || "").trim().toLowerCase();
              const telemetry = payload.telemetry && typeof payload.telemetry === "object" ? payload.telemetry : {};
              let nextStatusText = payload.message || "Processing...";
              if (stage === "transcribing") {
                const chunksDone = Number(telemetry.stt_chunks_completed || 0);
                const chunksTotal = Number(telemetry.stt_chunks_total || 0);
                const elapsedMs = Number(telemetry.transcription_elapsed_ms || 0);
                let etaMs = Number(telemetry.transcription_eta_ms);
                if (!Number.isFinite(etaMs) || etaMs < 0) {
                  if (chunksDone > 0 && chunksTotal > chunksDone && elapsedMs > 0) {
                    const avgChunkMs = elapsedMs / chunksDone;
                    etaMs = Math.max(0, Math.round(avgChunkMs * (chunksTotal - chunksDone)));
                  } else {
                    etaMs = NaN;
                  }
                }
                const etaLabel = formatDuration(etaMs);
                if (etaLabel) {
                  setEtaText(`ETA ${etaLabel}`);
                } else {
                  setEtaText("");
                }
              } else {
                setEtaText("");
              }
              setStatusText(nextStatusText);
              if (payload.progress != null) {
                setProgress(clampProgress(payload.progress));
              }
              if (payload.notice_type === "stt_provider_fallback") {
                const fallback = payload.fallback && typeof payload.fallback === "object" ? payload.fallback : {};
                const fromProvider = String(fallback.from_provider || "local").trim().toLowerCase() || "local";
                const toProvider = String(fallback.to_provider || "remote").trim().toLowerCase() || "remote";
                const noticeKey = `${fromProvider}->${toProvider}`;
                if (fallbackNoticeKeyRef.current !== noticeKey) {
                  fallbackNoticeKeyRef.current = noticeKey;
                  const notice = `Local STT (${fromProvider}) failed. Using ${toProvider} fallback.`;
                  setFallbackToast(notice);
                  setMessage?.(notice);
                }
              } else if (
                payload.stage === "transcribed" &&
                payload.metadata &&
                payload.metadata.provider_fallback_used
              ) {
                const fromProvider = String(payload.metadata.provider_fallback_from || "local").trim().toLowerCase();
                const toProvider = String(payload.metadata.provider || payload.metadata.provider_fallback_to || "remote")
                  .trim()
                  .toLowerCase();
                const noticeKey = `${fromProvider || "local"}->${toProvider || "remote"}`;
                if (fallbackNoticeKeyRef.current !== noticeKey) {
                  fallbackNoticeKeyRef.current = noticeKey;
                  const notice = `Transcription used fallback (${fromProvider || "local"} -> ${toProvider || "remote"}).`;
                  setFallbackToast(notice);
                  setMessage?.(notice);
                }
              }
            }
            if (eventName === "transcript") {
              const phase = String(payload.phase || "").trim().toLowerCase();
              const index = Number(payload.index || 0);
              const total = Number(payload.total || 0);
              if (phase === "transcribing") {
                const line = normalizeTranscriptLine(payload.text);
                if (line) {
                  setLiveTranscriptLines((previous) => {
                    if (previous[previous.length - 1] === line) {
                      return previous;
                    }
                    return [...previous, line].slice(-LIVE_STT_LINES_MAX);
                  });
                }
              } else if (index > 0 && total > 0) {
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

      {(statusText || isProcessing) && (
        <div className="hidden md:block min-w-[180px] max-w-[260px]">
          <p className="text-[11px] text-gray-500 truncate">{statusText || "Processing..."}</p>
          {etaText && <p className="text-[10px] text-gray-400">{etaText}</p>}
          <div className="mt-1 h-1 rounded-full bg-gray-200">
            <div
              className="h-1 rounded-full bg-gray-500 transition-all duration-200"
              style={{ width: `${Math.round(clampProgress(progress) * 100)}%` }}
            />
          </div>
          {liveTranscriptLines.length > 0 && (
            <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1">
              {liveTranscriptLines.slice(-3).map((line, index) => (
                <p key={`${index}-${line.slice(0, 24)}`} className="text-[10px] text-gray-500 truncate">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

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
  setConversationId: PropTypes.func,
  setFileName: PropTypes.func,
  setMessage: PropTypes.func,
};
