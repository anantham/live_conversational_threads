import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import FileUpload from "../components/FileUpload";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import SessionTranscriptOverlay from "../components/transcript/SessionTranscriptOverlay";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { useAutoSave } from "../hooks/useAutoSave";
import useLocalConversationDraft from "../hooks/useLocalConversationDraft";
import { useUpload } from "../contexts/UploadContext";
import { fetchAudioRecoveryStatus, recoverConversationAudio } from "../services/audioRecoveryApi";
import { fetchConversationObservability } from "../services/conversationDiagnosticsApi";
import { saveConversationToServer } from "../utils/SaveConversation";
import {
  buildConversationDebugExport,
  downloadConversationDebugExport,
} from "../components/audio/exportSessionDebug";
import { deriveSuggestedConversationTitle } from "../utils/conversationTitle";
import {
  applyChunkPatch,
  applyGraphPatch,
  mergeGraphLayers,
  normalizeGraphDataPayload,
  normalizeGraphPatchPayload,
} from "./newConversationGraphState";

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function formatDraftUpdatedAt(isoString) {
  if (!isoString) return "";
  const updatedAt = new Date(isoString);
  if (Number.isNaN(updatedAt.getTime())) return "";

  const diffMs = Date.now() - updatedAt.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return updatedAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: updatedAt.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [draftGraphData, setDraftGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [speakerRefreshKey, setSpeakerRefreshKey] = useState(0);
  const [chunkDict, setChunkDict] = useState({});
  const [draftChunkDict, setDraftChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [transcriptMinimized, setTranscriptMinimized] = useState(false);
  const [liveTranscriptState, setLiveTranscriptState] = useState({
    recording: false,
    liveTranscriptLines: [],
    statusLine: "",
  });
  const [audioRecovery, setAudioRecovery] = useState(null);
  const [audioRecoveryBusy, setAudioRecoveryBusy] = useState(false);
  const [recoveredDraftSaveState, setRecoveredDraftSaveState] = useState("idle");
  const [sessionActionBusy, setSessionActionBusy] = useState("");
  const audioRef = useRef(null);

  const navigate = useNavigate();
  const searchParams = new URLSearchParams(window.location.search);
  const autostart = searchParams.get("autostart") === "true";

  // Subscribe to app-level upload context so file upload events flow into this page
  const upload = useUpload();

  const displayGraphData = useMemo(
    () => mergeGraphLayers(graphData, draftGraphData),
    [draftGraphData, graphData]
  );
  const displayChunkDict = useMemo(
    () => ({ ...chunkDict, ...draftChunkDict }),
    [chunkDict, draftChunkDict]
  );

  // All nodes flattened (graph renders all chunks, not just the last one)
  const allNodes = useMemo(
    () => (displayGraphData || []).flat(),
    [displayGraphData]
  );

  const hasData = allNodes.length > 0;
  const hasFinalizedData = (graphData?.[graphData.length - 1] || []).length > 0;
  const hasChunkData = Object.keys(normalizeObject(displayChunkDict)).length > 0;
  const sessionTitleSuggestion = useMemo(
    () => deriveSuggestedConversationTitle(displayGraphData),
    [displayGraphData]
  );

  const { saveStatus, lastSavedAt, triggerSave } = useAutoSave({
    conversationId,
    graphData,
    conversationName: fileName || undefined,
    enabled: hasFinalizedData,
  });

  // Resolve selected node data for detail panel — search all chunks
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return allNodes.find((n) => n.id === selectedNode) || null;
  }, [selectedNode, allNodes]);
  const uploadTranscriptActive = upload.isProcessing && upload.liveTranscriptLines.length > 0;
  const liveTranscriptActive = liveTranscriptState.liveTranscriptLines.length > 0;
  const transcriptOverlay = useMemo(() => {
    if (uploadTranscriptActive) {
      return {
        mode: "upload",
        lines: upload.liveTranscriptLines,
        statusText: upload.statusText || "Processing...",
        etaText: upload.etaText || "",
        progress: upload.progress,
      };
    }

    if (liveTranscriptActive) {
      return {
        mode: "live",
        lines: liveTranscriptState.liveTranscriptLines,
        statusText: liveTranscriptState.recording
          ? (liveTranscriptState.statusLine || "Live transcript")
          : "Session draft",
        etaText: "",
        progress: null,
      };
    }

    return null;
  }, [
    liveTranscriptActive,
    liveTranscriptState.liveTranscriptLines,
    liveTranscriptState.recording,
    liveTranscriptState.statusLine,
    upload.etaText,
    upload.liveTranscriptLines,
    upload.progress,
    upload.statusText,
    uploadTranscriptActive,
  ]);
  const transcriptOverlayVisible = Boolean(transcriptOverlay);
  const graphViewportKey = `${selectedNodeData ? "detail-open" : "detail-closed"}:${transcriptOverlayVisible ? (transcriptMinimized ? "captions" : "transcript") : "clear"}`;
  const graphViewportStyle = useMemo(() => {
    if (!transcriptOverlayVisible) {
      return undefined;
    }

    return {
      bottom: transcriptMinimized ? "4.5rem" : "40%",
    };
  }, [transcriptMinimized, transcriptOverlayVisible]);

  // Speaker color map (shared between graph, ribbon, legend)
  const speakerColorMap = useMemo(() => buildSpeakerColorMap(allNodes), [allNodes]);

  const handleDataReceived = useCallback((newData) => {
    const normalized = normalizeGraphDataPayload(newData);
    if (normalized === null) {
      console.warn(
        "[NewConversation] Ignoring malformed existing_json payload."
      );
      return;
    }
    if (normalized.length === 0) {
      setDraftGraphData([]);
      setDraftChunkDict({});
    }
    setGraphData(normalized);
  }, []);

  const handleChunksReceived = useCallback((chunks) => setChunkDict((prev) => ({ ...prev, ...chunks })), []);

  const handleGraphPatchReceived = useCallback((patchPayload) => {
    const patch = normalizeGraphPatchPayload(patchPayload);
    if (!patch) {
      console.warn("[NewConversation] Ignoring malformed graph_patch payload.");
      return;
    }

    const applyToDraftLayer = patch.kind === "draft" || patch.kind === "draft_clear";

    if (applyToDraftLayer) {
      setDraftGraphData((previous) => applyGraphPatch(previous, patch));
      setDraftChunkDict((previous) => applyChunkPatch(previous, patch));
      return;
    }

    setGraphData((previous) => applyGraphPatch(previous, patch));
    setChunkDict((previous) => applyChunkPatch(previous, patch));

    if (patch.removeNodeIds.length > 0 || patch.removeChunkIds.length > 0) {
      setDraftGraphData((previous) => applyGraphPatch(previous, patch));
      setDraftChunkDict((previous) => applyChunkPatch(previous, patch));
    }
  }, []);

  // (upload hook moved earlier — needed before transcriptOverlayVisible)
  const localDraftSnapshot = useMemo(
    () => ({
      conversationId,
      fileName,
      message,
      graphData,
      draftGraphData,
      chunkDict,
      draftChunkDict,
    }),
    [chunkDict, conversationId, draftChunkDict, draftGraphData, fileName, graphData, message]
  );
  const {
    availableDraft,
    availableDraftSummary,
    clearAvailableDraft,
    discardAvailableDraft,
    dismissAvailableDraft,
    isCheckingDraft,
    persistDraftNow,
    restoreAvailableDraft,
  } = useLocalConversationDraft({
    snapshot: localDraftSnapshot,
  });

  const messageTone = useMemo(() => {
    const normalized = String(message || "").toLowerCase();
    if (!normalized) return "info";
    if (normalized.includes("failed") || normalized.includes("error")) return "error";
    if (normalized.includes("without backend observability") || normalized.includes("canceled")) return "warning";
    if (normalized.includes("saved") || normalized.includes("exported") || normalized.includes("ready")) return "success";
    return "info";
  }, [message]);
  useEffect(() => {
    upload.subscribe({
      onDataReceived: handleDataReceived,
      onChunksReceived: handleChunksReceived,
      onGraphPatchReceived: handleGraphPatchReceived,
      setConversationId,
      setFileName,
      setMessage,
    });

    // On mount, consume any buffered data from an upload that started before we mounted
    const buffered = upload.consumeBuffered();
    if (buffered.graphData) handleDataReceived(buffered.graphData);
    if (buffered.chunkDict) handleChunksReceived(buffered.chunkDict);
    if (buffered.conversationId) setConversationId(buffered.conversationId);
    if (buffered.fileName) setFileName(buffered.fileName);
    if (buffered.message) setMessage(buffered.message);
    buffered.graphPatches?.forEach(handleGraphPatchReceived);

    return () => upload.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedNode) return;
    if (allNodes.some((node) => node.id === selectedNode)) return;
    setSelectedNode(null);
  }, [allNodes, selectedNode]);

  const hasRecoverableLocalState = useMemo(
    () =>
      hasData ||
      Object.keys(normalizeObject(displayChunkDict)).length > 0 ||
      Boolean(String(fileName || "").trim()) ||
      Boolean(String(message || "").trim()),
    [displayChunkDict, fileName, hasData, message]
  );
  const sessionActionsVisible = !upload.isProcessing && !liveTranscriptState.recording && hasRecoverableLocalState;
  const savePayload = useMemo(() => ({
    graphData: graphData.length > 0 ? graphData : draftGraphData,
    chunkDict: hasChunkData ? displayChunkDict : {},
  }), [displayChunkDict, draftGraphData, graphData, hasChunkData]);

  useEffect(() => {
    let cancelled = false;

    const draftConversationId = String(availableDraftSummary?.conversationId || "").trim();
    if (!draftConversationId || hasRecoverableLocalState) {
      setAudioRecovery(null);
      return undefined;
    }

    void (async () => {
      try {
        const status = await fetchAudioRecoveryStatus(draftConversationId);
        if (!cancelled) {
          setAudioRecovery(status);
        }
      } catch (error) {
        console.warn("[AudioRecovery] Failed to load audio recovery status:", error);
        if (!cancelled) {
          setAudioRecovery(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [availableDraftSummary, hasRecoverableLocalState]);

  const handleResumeLocalDraft = useCallback(() => {
    const draft = restoreAvailableDraft();
    if (!draft) return;

    setConversationId(draft.conversationId || crypto.randomUUID());
    setFileName(String(draft.fileName || "").trim());
    setMessage(
      String(draft.message || "").trim() || "Restored local draft from this browser."
    );
    setGraphData(Array.isArray(draft.graphData) ? draft.graphData : []);
    setDraftGraphData(Array.isArray(draft.draftGraphData) ? draft.draftGraphData : []);
    setChunkDict(normalizeObject(draft.chunkDict));
    setDraftChunkDict(normalizeObject(draft.draftChunkDict));
    setSelectedNode(null);
    setTranscriptMinimized(false);
    if (audioRecovery?.recoverable) {
      setMessage("Restored local draft. Existing audio buffer will continue stitching into this conversation.");
    }
  }, [audioRecovery?.recoverable, restoreAvailableDraft]);

  const handleDiscardLocalDraft = useCallback(() => {
    void discardAvailableDraft();
  }, [discardAvailableDraft]);

  const resetForNewConversation = useCallback(() => {
    setConversationId(crypto.randomUUID());
    setFileName("");
    setMessage("");
    setGraphData([]);
    setDraftGraphData([]);
    setChunkDict({});
    setDraftChunkDict({});
    setSelectedNode(null);
    setTranscriptMinimized(false);
    setLiveTranscriptState({
      recording: false,
      liveTranscriptLines: [],
      statusLine: "",
    });
    setAudioRecovery(null);
    setSessionActionBusy("");
  }, []);

  const handleStartNewConversation = useCallback(() => {
    dismissAvailableDraft();
    resetForNewConversation();
  }, [dismissAvailableDraft, resetForNewConversation]);

  const handleRecoverAudio = useCallback(async () => {
    const draftConversationId = String(availableDraftSummary?.conversationId || "").trim();
    if (!draftConversationId || audioRecoveryBusy) return;
    setAudioRecoveryBusy(true);
    try {
      const payload = await recoverConversationAudio(draftConversationId);
      setAudioRecovery(payload);
      if (payload.download_url) {
        setMessage("Recovered audio is ready to download.");
      } else {
        setMessage("Recovered available audio for this draft.");
      }
    } catch (error) {
      console.warn("[AudioRecovery] Failed to recover audio:", error);
      setMessage(`Audio recovery failed: ${error?.message || "Unknown error"}`);
    } finally {
      setAudioRecoveryBusy(false);
    }
  }, [audioRecoveryBusy, availableDraftSummary, setMessage]);

  const handleBack = useCallback(() => {
    if (hasData) {
      setShowBackConfirm(true);
    } else {
      navigate("/");
    }
  }, [hasData, navigate]);

  const handleConfirmBack = useCallback(async () => {
    await Promise.all([
      audioRef.current?.stopRecording(),
      triggerSave(),
    ]);
    navigate("/");
  }, [navigate, triggerSave]);

  useEffect(() => {
    if (liveTranscriptState.recording) return;
    if (String(fileName || "").trim()) return;
    if (!sessionTitleSuggestion) return;
    setFileName(sessionTitleSuggestion);
  }, [fileName, liveTranscriptState.recording, sessionTitleSuggestion]);

  const persistSessionArtifact = useCallback(async () => {
    const normalizedName = String(fileName || sessionTitleSuggestion || "").trim();
    if (!normalizedName) {
      throw new Error("Add a conversation name before saving.");
    }
    if (!savePayload.graphData?.length || !Object.keys(savePayload.chunkDict || {}).length) {
      throw new Error("No finalized conversation data is ready to save yet.");
    }

    setFileName(normalizedName);
    const [artifactResult] = await Promise.all([
      saveConversationToServer({
        fileName: normalizedName,
        chunkDict: savePayload.chunkDict,
        graphData: savePayload.graphData,
        conversationId,
      }),
      triggerSave(),
    ]);

    if (!artifactResult?.success) {
      throw new Error(artifactResult?.message || "Save failed");
    }

    return { normalizedName, message: artifactResult.message || "Saved!" };
  }, [conversationId, fileName, savePayload.chunkDict, savePayload.graphData, sessionTitleSuggestion, triggerSave]);

  const handleSaveAndExit = useCallback(async () => {
    setSessionActionBusy("save-exit");
    try {
      const result = await persistSessionArtifact();
      setMessage(`Conversation "${result.normalizedName}" saved. ${result.message}`);
      navigate("/");
    } catch (error) {
      setMessage(`Save failed: ${error?.message || "Unknown error"}`);
    } finally {
      setSessionActionBusy("");
    }
  }, [navigate, persistSessionArtifact]);

  const handleSaveAndStartNew = useCallback(async () => {
    setSessionActionBusy("save-new");
    try {
      const result = await persistSessionArtifact();
      resetForNewConversation();
      setMessage(`Conversation "${result.normalizedName}" saved. Starting a new recording.`);
      window.setTimeout(() => {
        void audioRef.current?.startRecording?.();
      }, 0);
    } catch (error) {
      setMessage(`Save failed: ${error?.message || "Unknown error"}`);
    } finally {
      setSessionActionBusy("");
    }
  }, [persistSessionArtifact, resetForNewConversation]);

  const handleDiscardCurrentSession = useCallback(async () => {
    await clearAvailableDraft();
    resetForNewConversation();
    setMessage("Discarded the current session draft.");
  }, [resetForNewConversation, clearAvailableDraft]);

  const handleSaveRecoveredDraft = useCallback(async () => {
    if (recoveredDraftSaveState === "saving") {
      return;
    }

    const draft = availableDraft;
    if (!draft) {
      setMessage("No recoverable draft is available to save.");
      return;
    }

    const suggestedName = String(draft.fileName || availableDraftSummary?.title || "").trim();
    const newName = prompt("Enter a name for this recovered draft:", suggestedName);
    if (!newName) {
      setMessage("Save canceled. No file name provided.");
      return;
    }

    const normalizedDraft = {
      ...draft,
      fileName: newName.trim(),
    };

    const draftGraphLayers = Array.isArray(normalizedDraft.graphData)
      ? normalizedDraft.graphData
      : [];
    const draftChunks = normalizeObject(normalizedDraft.chunkDict);

    if (draftGraphLayers.length === 0 || Object.keys(draftChunks).length === 0) {
      setMessage("Recovered draft is missing graph or chunk data.");
      void persistDraftNow(normalizedDraft);
      return;
    }

    setRecoveredDraftSaveState("saving");
    try {
      const result = await saveConversationToServer({
        fileName: newName,
        chunkDict: draftChunks,
        graphData: draftGraphLayers,
        conversationId: normalizedDraft.conversationId || crypto.randomUUID(),
      });

      if (!result.success) {
        setRecoveredDraftSaveState("error");
        setMessage(`Save failed: ${result.message}`);
        void persistDraftNow(normalizedDraft);
        return;
      }

      await clearAvailableDraft();
      setRecoveredDraftSaveState("saved");
      setAudioRecovery(null);
      setMessage(`Recovered draft saved as "${newName.trim()}". ${result.message}`);
    } catch (error) {
      console.error("[NewConversation] Failed to save recovered draft:", error);
      setRecoveredDraftSaveState("error");
      setMessage(`Save failed: ${error?.message || "Unknown error"}`);
      void persistDraftNow(normalizedDraft);
    }
  }, [
    availableDraft,
    availableDraftSummary?.title,
    clearAvailableDraft,
    persistDraftNow,
    recoveredDraftSaveState,
    setMessage,
  ]);

  const handleExportConversationDebug = useCallback(async () => {
    const audioSession = audioRef.current?.getSessionDebugSnapshot?.() || null;
    let backendObservability = {};
    try {
      backendObservability = conversationId
        ? await fetchConversationObservability(conversationId)
        : {};
    } catch (error) {
      console.warn("[NewConversation] Failed to load backend session observability:", error);
      setMessage(`Exporting without backend observability: ${error?.message || "Unknown error"}`);
    }
    const exportPayload = buildConversationDebugExport({
      conversationId,
      fileName,
      message,
      graphData,
      draftGraphData,
      chunkDict,
      draftChunkDict,
      audioRecovery,
      audioSession,
      backendObservability,
    });
    downloadConversationDebugExport(exportPayload, conversationId, fileName);
    setMessage("Session debug JSON exported.");
  }, [
    audioRecovery,
    conversationId,
    chunkDict,
    draftChunkDict,
    draftGraphData,
    fileName,
    graphData,
    message,
    setMessage,
  ]);

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="absolute top-3 left-3 z-30 p-3 text-slate-600 hover:text-slate-900 transition"
        aria-label="Back"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Back confirmation dialog */}
      {showBackConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-lg p-5 max-w-xs text-center space-y-3">
            <p className="text-sm text-gray-700">
              Leave this session draft?
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Auto-save is active. Save the draft before leaving if you want a stable conversation artifact.
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowBackConfirm(false)}
                className="px-4 py-3 text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBack}
                className="px-4 py-3 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 transition"
              >
                Save & Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {!isCheckingDraft && availableDraftSummary && !hasRecoverableLocalState && (
        <div className="absolute top-4 left-1/2 z-20 w-[min(92vw,30rem)] -translate-x-1/2 rounded-2xl border border-amber-200 bg-white/95 px-5 py-4 shadow-lg backdrop-blur">
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-amber-600">
                Recovered Draft
              </p>
              <h2 className="mt-1 truncate text-sm font-semibold text-slate-800">
                {availableDraftSummary.title}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Updated {formatDraftUpdatedAt(availableDraftSummary.updatedAt)}
                {availableDraftSummary.nodeCount > 0
                  ? ` · ${availableDraftSummary.nodeCount} nodes`
                  : ""}
                {availableDraftSummary.chunkCount > 0
                  ? ` · ${availableDraftSummary.chunkCount} chunks`
                  : ""}
              </p>
              {audioRecovery && (
                <p className="mt-1 text-xs text-slate-500">
                  {audioRecovery.audio?.has_wav
                    ? "Saved audio available."
                    : audioRecovery.recoverable
                      ? "Recoverable audio buffer found."
                      : "No saved audio yet."}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {audioRecovery?.download_url && (
                <a
                  href={audioRecovery.download_url}
                  className="rounded-full px-3 py-1.5 text-xs text-blue-600 transition hover:text-blue-700"
                >
                  Download Audio
                </a>
              )}
              {audioRecovery?.recoverable && (
                <button
                  onClick={handleRecoverAudio}
                  disabled={audioRecoveryBusy}
                  className="rounded-full px-3 py-1.5 text-xs text-slate-600 transition hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {audioRecoveryBusy ? "Recovering..." : "Recover Audio"}
                </button>
              )}
              <button
                onClick={handleSaveRecoveredDraft}
                disabled={recoveredDraftSaveState === "saving"}
                className="rounded-full px-3 py-1.5 text-xs text-slate-600 transition hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {recoveredDraftSaveState === "saving" ? "Saving..." : "Save As…"}
              </button>
              <button
                onClick={handleStartNewConversation}
                className="rounded-full px-3 py-1.5 text-xs text-slate-600 transition hover:text-slate-800"
              >
                Start New Session
              </button>
              <button
                onClick={handleDiscardLocalDraft}
                className="rounded-full px-3 py-1.5 text-xs text-slate-400 transition hover:text-red-600"
              >
                Discard
              </button>
              <button
                onClick={handleResumeLocalDraft}
                className="rounded-full bg-slate-900 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 ml-auto"
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main graph area */}
      <div className="flex-1 relative min-h-0">
        {/* Graph always renders when data exists */}
        {hasData && (
          <>
            <div
              className={`absolute inset-0 transition-all duration-200 ${
                selectedNodeData ? "sm:right-80" : ""
              }`}
              style={graphViewportStyle}
            >
              <MinimalGraph
                graphData={displayGraphData}
                selectedNode={selectedNode}
                setSelectedNode={setSelectedNode}
                viewportReservationKey={graphViewportKey}
                onVisibleLevelChange={(view) => {
                  setVisibleGraphLevel(view?.mode === "semantic" ? view.level : null);
                }}
              />
              <MinimalLegend
                speakerColorMap={speakerColorMap}
                conversationId={conversationId}
                refreshKey={speakerRefreshKey}
              />
            </div>
          </>
        )}

        {transcriptOverlayVisible && (
          <SessionTranscriptOverlay
            hasData={hasData}
            minimized={transcriptMinimized}
            onExpand={() => setTranscriptMinimized(false)}
            onMinimize={() => setTranscriptMinimized(true)}
            lines={transcriptOverlay.lines}
            mode={transcriptOverlay.mode}
            progress={transcriptOverlay.progress}
            statusText={transcriptOverlay.statusText}
            etaText={transcriptOverlay.etaText}
          />
        )}

        {/* Node detail panel */}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={displayChunkDict}
            conversationId={conversationId}
            onClose={() => setSelectedNode(null)}
            onSpeakerRenamed={(speakerId, newName) => {
              setGraphData((prev) =>
                prev.map((chunk) =>
                  Array.isArray(chunk)
                    ? chunk.map((node) =>
                        node.speaker_id === speakerId
                          ? { ...node, speaker_display: newName }
                          : node
                      )
                    : chunk
                )
              );
              setSpeakerRefreshKey((value) => value + 1);
            }}
          />
        )}
      </div>

      {/* Timeline ribbon */}
      {hasData && (
        <TimelineRibbon
          graphData={displayGraphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          semanticLevel={visibleGraphLevel}
        />
      )}

      {sessionActionsVisible && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 z-20 w-[min(94vw,42rem)] -translate-x-1/2 px-3">
          <div className="pointer-events-auto rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-lg backdrop-blur">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">
                  Session Draft
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  Recording has stopped. Name this conversation, then save and exit or start the next one.
                </p>
                <label className="mt-3 block">
                  <span className="mb-1 block text-xs font-medium text-slate-700">Conversation Name</span>
                  <input
                    type="text"
                    value={fileName}
                    onChange={(event) => setFileName(event.target.value)}
                    placeholder={sessionTitleSuggestion || "Conversation name"}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                  />
                </label>
                {sessionTitleSuggestion && !String(fileName || "").trim() && (
                  <p className="mt-1 text-xs text-slate-500">
                    Suggested title: {sessionTitleSuggestion}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={handleDiscardCurrentSession}
                  disabled={Boolean(sessionActionBusy)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Discard Draft
                </button>
                <button
                  type="button"
                  onClick={handleSaveAndExit}
                  disabled={Boolean(sessionActionBusy)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sessionActionBusy === "save-exit" ? "Saving..." : "Save & Exit"}
                </button>
                <button
                  type="button"
                  onClick={handleSaveAndStartNew}
                  disabled={Boolean(sessionActionBusy)}
                  className="rounded-full bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sessionActionBusy === "save-new" ? "Saving..." : "Save & Start New"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-save status indicator */}
      {hasFinalizedData && (
        <div className="absolute bottom-16 right-3 z-20 text-[10px] text-gray-400 select-none">
          {saveStatus === "saving" && "Saving…"}
          {saveStatus === "saved" && lastSavedAt && (
            <>Saved {lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>
          )}
          {saveStatus === "error" && (
            <span className="text-red-400">Save failed</span>
          )}
        </div>
      )}

      {message && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-20 w-[min(92vw,32rem)] -translate-x-1/2 px-3">
          <div
            className={`pointer-events-auto flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${
              messageTone === "error"
                ? "border-red-200 bg-red-50/95 text-red-700"
                : messageTone === "warning"
                  ? "border-amber-200 bg-amber-50/95 text-amber-800"
                  : messageTone === "success"
                    ? "border-emerald-200 bg-emerald-50/95 text-emerald-800"
                    : "border-slate-200 bg-white/95 text-slate-700"
            }`}
            role="status"
            aria-live="polite"
          >
            <p className="min-w-0 flex-1">{message}</p>
            <button
              type="button"
              onClick={() => setMessage("")}
              className="shrink-0 text-xs font-medium opacity-70 transition hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Audio footer */}
      <div className="shrink-0 w-full py-2 px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
        <div className="w-full max-w-5xl flex items-center justify-center gap-4">
          <FileUpload />
          <button
            type="button"
            onClick={handleExportConversationDebug}
            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            title="Export graph, transcript, and session telemetry as JSON"
          >
            Export Session JSON
          </button>
          <AudioInput
            ref={audioRef}
            onDataReceived={handleDataReceived}
            onChunksReceived={handleChunksReceived}
            onGraphPatchReceived={handleGraphPatchReceived}
            onLiveTranscriptStateChange={setLiveTranscriptState}
            chunkDict={chunkDict}
            graphData={graphData}
            conversationId={conversationId}
            setConversationId={setConversationId}
            setMessage={setMessage}
            message={message}
            fileName={fileName}
            setFileName={setFileName}
            autostart={autostart}
          />
        </div>
      </div>
    </div>
  );
}
