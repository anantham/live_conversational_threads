import { useEffect, useRef, useState } from "react";

import { API_BASE_URL, apiHeaders, invalidateApiCache, readErrorMessage } from "../../services/apiClient";
import { useByok } from "../../contexts/byokContext";
import { randomUUID } from "../../utils/uuid";
import { makeDebug } from "../../utils/debug";

// Upload progress logs expose internal STT topology (stt_http_url) and full
// telemetry blobs. Gate them off by default (AGENTS.md #9).
const debug = makeDebug("upload");

// No cap — accumulate all transcript lines so users can scroll back
// through the full conversation history during long uploads.

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
const MAX_UPLOAD_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;
const RETRYABLE_MESSAGE_MARKERS = [
  "backend unreachable",
  "connection reset",
  "failed to fetch",
  "networkerror",
  "temporarily unavailable",
  "timed out",
  "timeout",
];

const buildUploadError = (message, details = {}) => Object.assign(new Error(message), details);

const buildAbortError = (message = "Upload canceled.") =>
  buildUploadError(message, { name: "AbortError" });

const buildRetryDelayLabel = (delayMs) => {
  if (delayMs < 1000) return `${delayMs}ms`;
  const seconds = delayMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
};

const buildResumeHint = (error, { automatic = false } = {}) => {
  if (!error?.resumeAvailable) return "";
  const checkpointChunks = Number(error.checkpointChunks || 0);
  if (!Number.isFinite(checkpointChunks) || checkpointChunks <= 0) return "";
  const checkpointTotal = Number(error.checkpointTotalChunks || 0);
  const nextChunk = checkpointChunks + 1;
  const chunkLabel =
    checkpointTotal > 0 ? `chunk ${nextChunk}/${checkpointTotal}` : `chunk ${nextChunk}`;
  return automatic
    ? ` Resume will continue from ${chunkLabel}.`
    : ` Re-upload will resume from ${chunkLabel}.`;
};

const isRetryableUploadError = (error) => {
  if (!error || error.name === "AbortError") return false;
  if (error.retryable === true) return true;
  const message = String(error.message || "").trim().toLowerCase();
  return RETRYABLE_MESSAGE_MARKERS.some((marker) => message.includes(marker));
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

export default function useFileUploadStream({
  onDataReceived,
  onChunksReceived,
  onGraphPatchReceived,
  setConversationId,
  setFileName,
  setMessage,
  resetBuffered,
  onStreamSettled,
}) {
  const { ensureSessionToken } = useByok();
  const abortRef = useRef(null);
  const fallbackNoticeKeyRef = useRef("");
  const manualCancelRef = useRef(false);
  const retryTimeoutRef = useRef(null);
  const retryRejectRef = useRef(null);
  const settleTimeoutRef = useRef(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [fallbackToast, setFallbackToast] = useState("");
  const [resumeToast, setResumeToast] = useState("");
  const [etaText, setEtaText] = useState("");
  const [liveTranscriptLines, setLiveTranscriptLines] = useState([]);
  const [sttBackend, setSttBackend] = useState("");
  const [llmBackend, setLlmBackend] = useState("");
  const [audioDurationMs, setAudioDurationMs] = useState(null);

  useEffect(() => {
    if (!fallbackToast) return undefined;
    const timeoutId = window.setTimeout(() => setFallbackToast(""), 8000);
    return () => window.clearTimeout(timeoutId);
  }, [fallbackToast]);

  useEffect(() => {
    if (!resumeToast) return undefined;
    const timeoutId = window.setTimeout(() => setResumeToast(""), 10000);
    return () => window.clearTimeout(timeoutId);
  }, [resumeToast]);

  // NOTE: We intentionally do NOT abort on unmount. The upload stream is now
  // owned by the app-level UploadContext and must survive page navigation.
  // The user can explicitly cancel via cancelUpload().

  useEffect(() => () => {
    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    retryRejectRef.current = null;
    if (settleTimeoutRef.current) {
      window.clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
  }, []);

  const clearScheduledReset = () => {
    if (settleTimeoutRef.current) {
      window.clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
  };

  const clearRetryWait = (errorMessage = "Upload canceled.") => {
    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (retryRejectRef.current) {
      const reject = retryRejectRef.current;
      retryRejectRef.current = null;
      reject(buildAbortError(errorMessage));
    }
  };

  const resetVisualState = () => {
    setProgress(0);
    setEtaText("");
    setLiveTranscriptLines([]);
    setSttBackend("");
    setLlmBackend("");
    setAudioDurationMs(null);
  };

  const scheduleVisualReset = () => {
    clearScheduledReset();
    settleTimeoutRef.current = window.setTimeout(() => {
      resetVisualState();
      setStatusText("");
      settleTimeoutRef.current = null;
    }, 3000);
  };

  const cancelUpload = () => {
    manualCancelRef.current = true;
    clearRetryWait();
    abortRef.current?.abort();
  };

  const waitForRetryDelay = (delayMs) =>
    new Promise((resolve, reject) => {
      if (manualCancelRef.current) {
        reject(buildAbortError());
        return;
      }
      retryRejectRef.current = reject;
      retryTimeoutRef.current = window.setTimeout(() => {
        retryTimeoutRef.current = null;
        retryRejectRef.current = null;
        resolve();
      }, delayMs);
    });

  const runSingleAttempt = async ({ byokSessionToken, conversationId, file }) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("conversation_id", conversationId);
    if (byokSessionToken) {
      formData.append("byok_session_token", byokSessionToken);
      formData.append("provider", "openai_audio");
    }

    const abortController = new AbortController();
    abortRef.current = abortController;

    const response = await fetch(`${API_BASE_URL}/api/import/process-file`, {
      method: "POST",
      headers: apiHeaders(),
      body: formData,
      signal: abortController.signal,
    });
    if (!response.ok) {
      const detail = await readErrorMessage(response, `Upload failed (${response.status})`);
      throw buildUploadError(detail, {
        retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
        statusCode: response.status,
      });
    }
    if (!response.body) {
      throw buildUploadError("No stream body returned from process-file endpoint.", {
        retryable: true,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";
    let completed = false;

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
            const telemetry =
              payload.telemetry && typeof payload.telemetry === "object" ? payload.telemetry : {};
            const nextStatusText = payload.message || "Processing...";
            if (payload.stt_backend) {
              setSttBackend(payload.stt_backend);
              debug(
                `STT backend: ${payload.stt_backend}` +
                  (payload.stt_http_url ? ` → ${payload.stt_http_url}` : "") +
                  (telemetry.stt_http_url ? ` → ${telemetry.stt_http_url}` : "")
              );
            }
            if (payload.llm_backend) {
              setLlmBackend(payload.llm_backend);
            }
            if (stage === "resuming") {
              const ckChunks = Number(telemetry.checkpoint_chunks || 0);
              const ckTotal = Number(telemetry.checkpoint_total_chunks || 0);
              const resumeMsg = ckTotal > 0
                ? `Resuming from checkpoint (${ckChunks}/${ckTotal} chunks cached)`
                : `Resuming from checkpoint (${ckChunks} chunks cached)`;
              setResumeToast(resumeMsg);
            }
            if (payload.audio_duration_ms != null) {
              setAudioDurationMs(Number(payload.audio_duration_ms));
            }
            if (stage === "transcribing") {
              const chunksDone = Number(telemetry.stt_chunks_completed || 0);
              const chunksTotal = Number(telemetry.stt_chunks_total || 0);
              const elapsedMs = Number(telemetry.transcription_elapsed_ms || 0);
              const initialEtaMs = Number(telemetry.initial_eta_ms || 0);
              const hasHistory = initialEtaMs > 0;
              const MIN_CHUNKS_FOR_ETA = 3;

              let etaMs = Number(telemetry.transcription_eta_ms);
              if (!Number.isFinite(etaMs) || etaMs < 0) {
                if (chunksDone >= MIN_CHUNKS_FOR_ETA && chunksTotal > chunksDone && elapsedMs > 0) {
                  const avgChunkMs = elapsedMs / chunksDone;
                  etaMs = Math.max(0, Math.round(avgChunkMs * (chunksTotal - chunksDone)));
                } else {
                  etaMs = Number.NaN;
                }
              }

              const etaLabel = formatDuration(etaMs);
              if (chunksDone >= MIN_CHUNKS_FOR_ETA && etaLabel) {
                setEtaText(`ETA ${etaLabel}`);
              } else if (hasHistory) {
                const remaining = Math.max(0, initialEtaMs - elapsedMs);
                const histLabel = formatDuration(Math.round(remaining));
                setEtaText(histLabel ? `ETA ~${histLabel}` : "Calibrating...");
              } else {
                setEtaText(
                  chunksDone > 0
                    ? `Calibrating... (${chunksDone}/${chunksTotal} chunks)`
                    : "Calibrating ETA (first run)..."
                );
              }
            } else if (stage === "analyzing") {
              const chunksDone = Number(telemetry.analysis_chunks_completed || 0);
              const chunksTotal = Number(telemetry.analysis_chunks_total || 0);
              const elapsedMs = Number(telemetry.analysis_elapsed_ms || 0);
              let etaMs = Number(telemetry.analysis_eta_ms);
              if (!Number.isFinite(etaMs) || etaMs < 0) {
                if (chunksDone > 0 && chunksTotal > chunksDone && elapsedMs > 0) {
                  const avgChunkMs = elapsedMs / chunksDone;
                  etaMs = Math.max(0, Math.round(avgChunkMs * (chunksTotal - chunksDone)));
                } else {
                  etaMs = Number.NaN;
                }
              }
              const etaLabel = formatDuration(etaMs);
              if (etaLabel) {
                setEtaText(`ETA ${etaLabel}`);
              } else if (chunksDone === 0 && chunksTotal > 0) {
                setEtaText("Calculating ETA...");
              } else {
                setEtaText("");
              }
              debug(
                `[LLM Analysis] Chunk ${chunksDone}/${chunksTotal} | Elapsed: ${formatDuration(elapsedMs)} | ETA: ${formatDuration(etaMs)}`,
                telemetry
              );
            } else {
              setEtaText("");
            }
            setStatusText(nextStatusText);
            if (payload.progress != null) {
              setProgress(clampProgress(payload.progress));
            }
            if (payload.notice_type === "stt_provider_fallback") {
              const fallback =
                payload.fallback && typeof payload.fallback === "object" ? payload.fallback : {};
              const fromProvider =
                String(fallback.from_provider || "local").trim().toLowerCase() || "local";
              const toProvider =
                String(fallback.to_provider || "remote").trim().toLowerCase() || "remote";
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
              const fromProvider = String(payload.metadata.provider_fallback_from || "local")
                .trim()
                .toLowerCase();
              const toProvider = String(
                payload.metadata.provider || payload.metadata.provider_fallback_to || "remote"
              )
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
            const resumed = Boolean(payload.resumed);
            const elapsedMs = Number(
              payload.telemetry?.transcription_elapsed_ms || payload.telemetry?.total_elapsed_ms || 0
            );
            if (phase === "transcribing") {
              const line = normalizeTranscriptLine(payload.text);
              if (line) {
                setLiveTranscriptLines((previous) => {
                  const duplicateReplay =
                    resumed &&
                    previous.some(
                      (entry) => entry.chunkIndex === index && entry.text === line
                    );
                  if (duplicateReplay) {
                    return previous;
                  }
                  if (
                    previous.length > 0 &&
                    previous[previous.length - 1].chunkIndex === index &&
                    previous[previous.length - 1].text === line
                  ) {
                    return previous;
                  }
                  return [...previous, { text: line, chunkIndex: index, total, elapsedMs }];
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
            } else if (payload.type === "graph_patch") {
              onGraphPatchReceived?.(payload.data);
            }
          }
          if (eventName === "done") {
            completed = true;
            setProgress(1);
            setStatusText(`Done: ${payload.node_count || 0} nodes`);
            // Bust the conversation-list cache so the new (or backfilled-on-
            // cache-hit) conversation shows up immediately. Also bust the
            // specific conversation entry — re-imports may have refreshed
            // graph_data or audio.
            const finishedConvId = payload.conversation_id || payload.telemetry?.conversation_id || conversationId;
            invalidateApiCache("/conversations/");
            if (finishedConvId) {
              invalidateApiCache(`/conversations/${finishedConvId}`);
              invalidateApiCache(`/api/conversations/${finishedConvId}/audio/status`);
            }
            if (payload.file_name) {
              setFileName?.(payload.file_name);
            }
            const artifactExport =
              payload.artifact_export && typeof payload.artifact_export === "object"
                ? payload.artifact_export
                : null;
            const writtenFiles = Array.isArray(artifactExport?.written_files)
              ? artifactExport.written_files
              : [];
            const resolvedRootPath =
              artifactExport?.resolved_root_path || artifactExport?.root_path || "configured folder";
            const exportSuffix = writtenFiles.length
              ? ` Exported ${writtenFiles.length} file${writtenFiles.length === 1 ? "" : "s"} to ${resolvedRootPath}.`
              : "";
            setMessage?.(
              `Bulk upload complete (${payload.node_count || 0} nodes, ${payload.chunk_count || 0} chunks).${exportSuffix}`
            );
          }
          if (eventName === "error") {
            throw buildUploadError(payload.message || "Bulk upload failed.", {
              retryable: payload.retryable === true,
              resumeAvailable: payload.resume_available === true,
              checkpointChunks: Number(
                payload.checkpoint_chunks ?? payload.telemetry?.checkpoint_chunks ?? 0
              ),
              checkpointTotalChunks: Number(
                payload.checkpoint_total_chunks ?? payload.telemetry?.checkpoint_total_chunks ?? 0
              ),
              failureStage: String(payload.failure_stage || payload.telemetry?.failure_stage || ""),
              conversationId:
                payload.conversation_id || payload.telemetry?.conversation_id || conversationId,
            });
          }
        }
        boundaryIndex = streamBuffer.indexOf("\n\n");
      }
    }

    abortRef.current = null;
    if (!completed) {
      throw buildUploadError("Upload stream ended before completion.", { retryable: true });
    }
  };

  const processFile = async (file) => {
    if (!file || isProcessing) return;

    clearScheduledReset();
    clearRetryWait();
    manualCancelRef.current = false;
    resetBuffered?.();

    const nextConversationId = randomUUID();
    setConversationId?.(nextConversationId);
    setFileName?.(file.name.replace(/\.[^.]+$/, ""));
    onDataReceived?.([]);
    onChunksReceived?.({});
    setMessage?.("");

    setIsProcessing(true);
    resetVisualState();
    setProgress(0.02);
    setStatusText(`Uploading ${file.name}...`);
    setFallbackToast("");
    setResumeToast("");
    fallbackNoticeKeyRef.current = "";

    let byokSessionToken = "";
    let terminalError = null;
    let outcome = "failed";

    try {
      byokSessionToken = await ensureSessionToken();
      const totalAttempts = MAX_UPLOAD_RETRIES + 1;

      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (attempt > 1) {
          setStatusText(`Retrying upload (attempt ${attempt}/${totalAttempts})...`);
          setProgress((current) => clampProgress(Math.max(current, 0.08)));
        }

        try {
          await runSingleAttempt({
            byokSessionToken,
            conversationId: nextConversationId,
            file,
          });
          terminalError = null;
          outcome = "success";
          break;
        } catch (error) {
          abortRef.current = null;
          if (manualCancelRef.current || error?.name === "AbortError") {
            terminalError = null;
            outcome = "canceled";
            setStatusText("Upload canceled.");
            setMessage?.("Bulk upload canceled.");
            break;
          }

          terminalError = error;
          const retryable = isRetryableUploadError(error);
          const hasMoreAttempts = attempt < totalAttempts;
          if (retryable && hasMoreAttempts) {
            const delayMs = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
            const delayLabel = buildRetryDelayLabel(delayMs);
            const retryMessage = `Upload failed, retrying in ${delayLabel}.${buildResumeHint(error, { automatic: true })}`;
            setStatusText(
              `Retrying upload (attempt ${attempt + 1}/${totalAttempts}) in ${delayLabel}...`
            );
            setMessage?.(retryMessage.trim());
            try {
              await waitForRetryDelay(delayMs);
            } catch (delayError) {
              if (manualCancelRef.current || delayError?.name === "AbortError") {
                terminalError = null;
                outcome = "canceled";
                setStatusText("Upload canceled.");
                setMessage?.("Bulk upload canceled.");
                break;
              }
              terminalError = delayError;
              break;
            }
            continue;
          }

          break;
        }
      }

      if (terminalError) {
        const message = terminalError?.message || "Bulk upload failed.";
        setStatusText(message);
        setMessage?.(`${message}${buildResumeHint(terminalError)}`.trim());
      }
    } catch (error) {
      if (manualCancelRef.current || error?.name === "AbortError") {
        outcome = "canceled";
        setStatusText("Upload canceled.");
        setMessage?.("Bulk upload canceled.");
      } else {
        const message = error?.message || "Bulk upload failed.";
        setStatusText(message);
        setMessage?.(message);
      }
    } finally {
      abortRef.current = null;
      clearRetryWait();
      retryRejectRef.current = null;
      setIsProcessing(false);
      setEtaText("");
      manualCancelRef.current = false;
      onStreamSettled?.(outcome);
      if (outcome === "success" || outcome === "canceled") {
        scheduleVisualReset();
      }
    }
  };

  return {
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
  };
}
