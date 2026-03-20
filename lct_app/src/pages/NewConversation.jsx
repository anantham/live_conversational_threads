import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import FileUpload from "../components/FileUpload";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  applyChunkPatch,
  applyGraphPatch,
  mergeGraphLayers,
  normalizeGraphDataPayload,
  normalizeGraphPatchPayload,
} from "./newConversationGraphState";

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [draftGraphData, setDraftGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [draftChunkDict, setDraftChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const audioRef = useRef(null);

  const navigate = useNavigate();

  const displayGraphData = useMemo(
    () => mergeGraphLayers(graphData, draftGraphData),
    [draftGraphData, graphData]
  );
  const displayChunkDict = useMemo(
    () => ({ ...chunkDict, ...draftChunkDict }),
    [chunkDict, draftChunkDict]
  );

  const latestChunk = useMemo(
    () => displayGraphData?.[displayGraphData.length - 1] || [],
    [displayGraphData]
  );
  const hasData = latestChunk.length > 0;
  const hasFinalizedData = (graphData?.[graphData.length - 1] || []).length > 0;

  const { saveStatus, lastSavedAt, triggerSave } = useAutoSave({
    conversationId,
    graphData,
    conversationName: fileName || undefined,
    enabled: hasFinalizedData,
  });

  // Resolve selected node data for detail panel
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return latestChunk.find((n) => n.id === selectedNode) || null;
  }, [selectedNode, latestChunk]);

  // Speaker color map (shared between graph, ribbon, legend)
  const speakerColorMap = useMemo(() => buildSpeakerColorMap(latestChunk), [latestChunk]);

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

  const handleChunksReceived = useCallback((chunks) => setChunkDict(chunks), []);

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

  useEffect(() => {
    if (!selectedNode) return;
    if (latestChunk.some((node) => node.id === selectedNode)) return;
    setSelectedNode(null);
  }, [latestChunk, selectedNode]);

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

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="absolute top-3 left-3 z-30 p-3 text-gray-300 hover:text-gray-500 transition"
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
              End this recording?
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Auto-save is active. If cloud storage is unavailable, local fallback is used.
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
                End & Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main graph area */}
      <div className="flex-1 relative min-h-0">
        {hasData ? (
          <>
            <MinimalGraph
              graphData={displayGraphData}
              selectedNode={selectedNode}
              setSelectedNode={setSelectedNode}
            />
            <MinimalLegend speakerColorMap={speakerColorMap} />
          </>
        ) : (
          // Empty state — just breathing room
          <div className="w-full h-full" />
        )}

        {/* Node detail panel */}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={displayChunkDict}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>

      {/* Timeline ribbon */}
      {hasData && (
        <TimelineRibbon
          graphData={displayGraphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
        />
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

      {/* Audio footer */}
      <div className="shrink-0 w-full py-2 px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
        <div className="w-full max-w-5xl flex items-center justify-center gap-4">
          <FileUpload
            onDataReceived={handleDataReceived}
            onChunksReceived={handleChunksReceived}
            onGraphPatchReceived={handleGraphPatchReceived}
            setConversationId={setConversationId}
            setFileName={setFileName}
            setMessage={setMessage}
          />
          <AudioInput
            ref={audioRef}
            onDataReceived={handleDataReceived}
            onChunksReceived={handleChunksReceived}
            onGraphPatchReceived={handleGraphPatchReceived}
            chunkDict={chunkDict}
            graphData={graphData}
            conversationId={conversationId}
            setConversationId={setConversationId}
            setMessage={setMessage}
            message={message}
            fileName={fileName}
            setFileName={setFileName}
          />
        </div>
      </div>
    </div>
  );
}
