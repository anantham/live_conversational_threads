import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus } from "lucide-react";
import AudioInput from "../components/AudioInput";
import FileUpload from "../components/FileUpload";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import SearchDialog from "../components/SearchDialog";
import SessionTranscriptOverlay from "../components/transcript/SessionTranscriptOverlay";
import ConsumptionPrayerChip from "../components/conversation/ConsumptionPrayerChip";
import ConsumptionPrayerDrawer from "../components/conversation/ConsumptionPrayerDrawer";
import ParticipantPickerModal from "../components/conversation/ParticipantPickerModal";
import TranscriptSelectionToolbar from "../components/conversation/TranscriptSelectionToolbar";
import useTextSelection from "../components/conversation/useTextSelection";
import { triggerConsumptionPrayer, ConsumptionApiError } from "../services/consumptionApi";
import { fetchConversationParticipants } from "../services/participantsApi";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { useAutoSave } from "../hooks/useAutoSave";
import useLocalConversationDraft from "../hooks/useLocalConversationDraft";
import { useUpload } from "../contexts/UploadContext";
import { fetchAudioRecoveryStatus, recoverConversationAudio } from "../services/audioRecoveryApi";
import { fetchConversationObservability } from "../services/conversationDiagnosticsApi";
import { saveConversationToServer } from "../utils/SaveConversation";
import { apiFetch, saveConversationDraft } from "../services/apiClient";
import {
  buildConversationDebugExport,
  downloadConversationDebugExport,
} from "../components/audio/exportSessionDebug";
import { deriveSuggestedConversationTitle } from "../utils/conversationTitle";
import { randomUUID } from "../utils/uuid";
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
  // ADR-032 Part B pattern 3: argument-scaffold trace state lifted here
  // so NodeDetail can request a trace and MinimalGraph can dim.
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);
  // ADR-032 Part K: Cmd+K / "/" opens search.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "/" && !event.target?.matches?.("input, textarea, [contenteditable]")) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [speakerRefreshKey, setSpeakerRefreshKey] = useState(0);
  const [chunkDict, setChunkDict] = useState({});
  const [draftChunkDict, setDraftChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => randomUUID());
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

  // ----- Consumption-prayer state (Phase 6/7/20/21 ─ MVP manual-trigger UI) -----
  // The chip surfaces in the bottom-right when results are present. The
  // drawer opens on chip click and shows the pending-discussions list.
  // The selection toolbar appears when the user drags-selects in the
  // transcript pane and offers a prayer-type slot to trigger the lookup.
  const [consumptionState, setConsumptionState] = useState("idle"); // "idle" | "loading" | "error"
  const [consumptionResult, setConsumptionResult] = useState(null); // backend response body or null
  const [consumptionError, setConsumptionError] = useState("");
  const [consumptionDrawerOpen, setConsumptionDrawerOpen] = useState(false);
  const [knownContacts, setKnownContacts] = useState([]);

  // ----- Participant picker state -----
  // Auto-opens when arriving with ?autostart=true (i.e. New Conversation
  // was clicked and recording is starting). Stays mounted afterwards so
  // the late-joiner button can re-open it mid-recording.
  const [participantPickerOpen, setParticipantPickerOpen] = useState(false);
  const [savedParticipants, setSavedParticipants] = useState([]);
  const transcriptPaneRef = useRef(null);
  const { selection: transcriptSelection, clearSelection: clearTranscriptSelection } =
    useTextSelection(transcriptPaneRef);

  // Fetch the picker's contact list once at session mount. Failure is
  // non-fatal — toolbar just renders with no contact options.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/consumption-prayer/known-contacts")
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((body) => {
        if (cancelled) return;
        setKnownContacts(Array.isArray(body?.contacts) ? body.contacts : []);
      })
      .catch(() => {
        // logger isn't available; this is fine — empty list is graceful
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShowAgenda = useCallback(
    async ({ contactRef, selectedText }) => {
      setConsumptionState("loading");
      setConsumptionError("");
      try {
        const body = await triggerConsumptionPrayer({
          conversationId,
          contactRef,
          selectedText,
        });
        setConsumptionResult(body);
        setConsumptionState("idle");
        // Auto-open drawer when items present; if 0 items, leave drawer closed
        // so the chip shows a "0 pending" hint without forcing a takeover.
        if ((body.item_count || 0) > 0) {
          setConsumptionDrawerOpen(true);
        }
        clearTranscriptSelection();
      } catch (err) {
        const message =
          err instanceof ConsumptionApiError
            ? err.message
            : `Lookup failed: ${err?.message || "unknown error"}`;
        setConsumptionError(message);
        setConsumptionState("error");
      }
    },
    [conversationId, clearTranscriptSelection],
  );

  const navigate = useNavigate();
  const searchParams = new URLSearchParams(window.location.search);
  const autostart = searchParams.get("autostart") === "true";

  // Auto-open the participant picker once the backend confirms the
  // Conversation row exists. The signal arrives as a `session_started` WS
  // message right after stt_ws_session.ensure_conversation() runs — see
  // AudioInput → useTranscriptSockets → audioMessages plumbing. We only
  // auto-open on the first signal per autostart visit (subsequent reconnects
  // shouldn't re-pop the modal).
  const pickerAutoOpenedRef = useRef(false);
  const handleSessionStarted = useCallback(() => {
    if (!autostart) return;
    if (pickerAutoOpenedRef.current) return;
    pickerAutoOpenedRef.current = true;
    setParticipantPickerOpen(true);
  }, [autostart]);

  // Refresh the persistent name pill whenever the conversation_id changes
  // (e.g. recovered draft) so the user sees who's already in.
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    fetchConversationParticipants(conversationId).then((participants) => {
      if (!cancelled) setSavedParticipants(participants);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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

    setConversationId(draft.conversationId || randomUUID());
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
    setConversationId(randomUUID());
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
    // Save & Exit: persist to the server, then clear the local
    // safety-net draft. Without the clear() the next visit to /new
    // re-loads the stale local draft and prompts the user to
    // "recover" data they already saved.
    await Promise.all([
      audioRef.current?.stopRecording(),
      triggerSave(),
    ]);
    await clearAvailableDraft();
    navigate("/");
  }, [clearAvailableDraft, navigate, triggerSave]);

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
    // Activity gate: still require finalized work before treating this as
    // a meaningful save. Contents are NOT transmitted (canonical state is
    // already backend-persisted per ADR-030 §P7); we only check that the
    // session has produced something worth naming.
    if (!savePayload.graphData?.length || !Object.keys(savePayload.chunkDict || {}).length) {
      throw new Error("No finalized conversation data is ready to save yet.");
    }

    setFileName(normalizedName);
    // Persist the user-edited name through the draft endpoint (browser-
    // authoritative draft state per ADR-030 §D6). Trigger the autosave hook
    // in parallel so its lastSavedAt clock advances; both paths now route
    // through saveConversationDraft so this is essentially a single save.
    await Promise.all([
      saveConversationDraft(conversationId, { conversation_name: normalizedName }),
      triggerSave(),
    ]);

    return { normalizedName, message: "Saved!" };
  }, [conversationId, fileName, savePayload.chunkDict, savePayload.graphData, sessionTitleSuggestion, triggerSave]);

  const handleSaveAndExit = useCallback(async () => {
    setSessionActionBusy("save-exit");
    try {
      const result = await persistSessionArtifact();
      // Clear the local safety-net draft now that the server has the
      // canonical copy — otherwise next /new visit prompts to recover
      // data that's already been saved.
      await clearAvailableDraft();
      setMessage(`Conversation "${result.normalizedName}" saved. ${result.message}`);
      navigate("/");
    } catch (error) {
      setMessage(`Save failed: ${error?.message || "Unknown error"}`);
    } finally {
      setSessionActionBusy("");
    }
  }, [clearAvailableDraft, navigate, persistSessionArtifact]);

  const handleSaveAndStartNew = useCallback(async () => {
    setSessionActionBusy("save-new");
    try {
      const result = await persistSessionArtifact();
      // Clear the saved conversation's local draft slot so the new
      // recording doesn't inherit a stale recover prompt.
      await clearAvailableDraft();
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
  }, [clearAvailableDraft, persistSessionArtifact, resetForNewConversation]);

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
      // ADR-030 §D6 EXCEPTION: this is the one legitimate browser-side
      // semantic write path. A recovered IndexedDB draft may contain
      // graph data from a session whose live persistence failed (browser
      // crash, network loss before flush). The backend has no canonical
      // copy of this state, so the browser is the authoritative source.
      // A future ADR (recovery-ingest-endpoint) will replace this with
      // POST /api/conversations/{id}/recover-draft that materializes the
      // submitted state through the canonical pipeline. Until that lands,
      // this remains the only legacy path; do not add new callers.
      const result = await saveConversationToServer({
        fileName: newName,
        chunkDict: draftChunks,
        graphData: draftGraphLayers,
        conversationId: normalizedDraft.conversationId || randomUUID(),
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
        {/* Empty-state hint when no recording / file has produced data yet.
            Previously the canvas was just white space on mobile, leaving the
            page feeling broken before the user taps "Start Recording". */}
        {!hasData && !transcriptOverlayVisible && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-slate-500">
              Tap the mic below to start a live session
            </p>
            <p className="mt-1 text-xs text-slate-400">
              or upload an audio / transcript file
            </p>
            {typeof window !== "undefined" &&
              !window.isSecureContext &&
              !window.location.hostname.match(/^(localhost|127\.0\.0\.1)$/) && (
                <div className="mt-3 max-w-[22rem] text-amber-800 bg-amber-50/90 border border-amber-200 rounded-lg px-3 py-2.5 text-left">
                  <p className="text-xs font-medium">
                    Recording isn't available on this connection.
                  </p>
                  <p className="mt-1 text-[11px] text-amber-700">
                    The browser needs a secure (https://) link to access the microphone.
                    Please ask the admin running this server to enable HTTPS, then re-open
                    the app on the new URL.
                  </p>
                  <details className="mt-2 text-[10px] text-amber-600/90">
                    <summary className="cursor-pointer hover:text-amber-800 select-none">
                      Admin: how to enable HTTPS
                    </summary>
                    <div className="mt-1.5 space-y-1">
                      <p>
                        On the server host, run Tailscale Serve to publish this dev port over an
                        https tailnet URL:
                      </p>
                      <code className="font-mono text-[10px] block mt-1 px-1.5 py-1 bg-white rounded border border-amber-200 text-amber-900">
                        tailscale serve --bg {window.location.port || 43173}
                      </code>
                      <p className="mt-1">
                        Tailscale prints the resulting <code className="font-mono">https://…ts.net</code> URL.
                        Share that with end users. Stop with <code className="font-mono">tailscale serve --https=443 off</code>.
                      </p>
                      <p className="mt-1 text-amber-600/80">
                        Current host: <code className="font-mono">{window.location.host}</code>
                      </p>
                    </div>
                  </details>
                </div>
              )}
          </div>
        )}
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
                argumentTraceFrom={argumentTraceFrom}
                setArgumentTraceFrom={setArgumentTraceFrom}
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
          <div ref={transcriptPaneRef}>
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
          </div>
        )}

        {/* Consumption-prayer surfaces — chip (always-on), drawer (on demand),
            and selection toolbar (when text selected in transcript). All three
            populate via the same handleShowAgenda callback. */}
        <ConsumptionPrayerChip
          state={consumptionState}
          itemCount={consumptionResult?.item_count || 0}
          contactName={consumptionResult?.contact?.display_name || ""}
          errorMessage={consumptionError}
          onOpen={() => setConsumptionDrawerOpen(true)}
        />

        <ConsumptionPrayerDrawer
          open={consumptionDrawerOpen && Boolean(consumptionResult)}
          contact={consumptionResult?.contact}
          items={consumptionResult?.items || []}
          status={consumptionResult?.status || "ok"}
          notePath={consumptionResult?.note_path || ""}
          selectedText={consumptionResult?.selected_text || ""}
          triggeredAt={consumptionResult?.triggered_at || ""}
          onClose={() => setConsumptionDrawerOpen(false)}
        />

        <TranscriptSelectionToolbar
          selection={transcriptSelection}
          conversationContact={null /* future: from session-start contact picker */}
          knownContacts={knownContacts}
          onShowAgenda={handleShowAgenda}
          onClose={clearTranscriptSelection}
          loading={consumptionState === "loading"}
        />

        <ParticipantPickerModal
          open={participantPickerOpen}
          conversationId={conversationId}
          onClose={() => setParticipantPickerOpen(false)}
          onSaved={(participants) => setSavedParticipants(participants)}
        />

        {/* Node detail panel */}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={displayChunkDict}
            conversationId={conversationId}
            onClose={() => setSelectedNode(null)}
            onTraceAncestors={setArgumentTraceFrom}
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

      {/* Audio footer — a single horizontal toolbar on every viewport.
          Fits a phone now that each control is compact: mic is icon-only,
          the status HUD collapses to one dot on mobile, upload hides
          while recording. Export JSON is desktop-only (power/debug
          action, not for the live recording surface on a phone). The
          participants pill floats bottom-left on desktop (sm:fixed). */}
      <div className="shrink-0 w-full py-2 px-3 sm:px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
        <div className="w-full max-w-5xl flex flex-row flex-wrap items-center justify-center gap-3 sm:gap-4">
          {/* Participants — icon-only toolbar button. Tapping opens the
              picker modal (check/uncheck, search) — that modal is where
              you see + manage the cast, so the footer button itself
              carries no names. Tinted blue when participants are set. */}
          {!participantPickerOpen ? (
            <button
              type="button"
              onClick={() => setParticipantPickerOpen(true)}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                savedParticipants.length > 0
                  ? "border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              }`}
              title={
                savedParticipants.length > 0
                  ? `${savedParticipants.map((p) => p.display_name).join(", ")} — tap to edit`
                  : "Add participants"
              }
              aria-label={
                savedParticipants.length > 0
                  ? `Participants: ${savedParticipants
                      .map((p) => p.display_name)
                      .join(", ")}. Tap to edit.`
                  : "Add participants"
              }
            >
              <UserPlus size={18} />
            </button>
          ) : null}
          {/* Upload is an ALTERNATIVE to live recording — irrelevant once
              the mic is capturing. Phase-aware: hide it while recording. */}
          {!liveTranscriptState.recording ? <FileUpload /> : null}
          <button
            type="button"
            onClick={handleExportConversationDebug}
            className="hidden rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 sm:inline-flex"
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
            onSessionStarted={handleSessionStarted}
          />
        </div>
      </div>
      <SearchDialog
        open={searchOpen}
        nodes={(displayGraphData || []).flat().filter((n) => n && typeof n === "object" && !Array.isArray(n))}
        onSelect={(nodeId) => setSelectedNode(nodeId)}
        onClose={() => setSearchOpen(false)}
      />
    </div>
  );
}
