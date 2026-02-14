import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import { buildSpeakerColorMap } from "../components/graphConstants";

function normalizeGraphDataPayload(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }

  if (payload.length === 0) {
    return [];
  }

  // Legacy/expected shape: Array<Array<Node>>
  if (Array.isArray(payload[0])) {
    return payload
      .map((chunk) =>
        Array.isArray(chunk)
          ? chunk.filter((item) => item && typeof item === "object" && !Array.isArray(item))
          : []
      )
      .filter((chunk) => chunk.length > 0);
  }

  // New backend shape: Array<Node>; rebuild chunk groups by chunk_id.
  if (payload[0] && typeof payload[0] === "object") {
    const chunkOrder = [];
    const chunkMap = new Map();

    payload.forEach((node, index) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }
      const chunkId =
        typeof node.chunk_id === "string" && node.chunk_id.trim()
          ? node.chunk_id
          : `legacy-${index}`;
      if (!chunkMap.has(chunkId)) {
        chunkMap.set(chunkId, []);
        chunkOrder.push(chunkId);
      }
      chunkMap.get(chunkId).push(node);
    });

    return chunkOrder.map((id) => chunkMap.get(id)).filter((chunk) => chunk.length > 0);
  }

  return null;
}

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [showBackConfirm, setShowBackConfirm] = useState(false);

  const navigate = useNavigate();

  const latestChunk = graphData?.[graphData.length - 1] || [];
  const hasData = latestChunk.length > 0;

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
    setGraphData(normalized);
  }, []);

  const handleChunksReceived = useCallback((chunks) => setChunkDict(chunks), []);

  const handleBack = useCallback(() => {
    if (hasData) {
      setShowBackConfirm(true);
    } else {
      navigate("/");
    }
  }, [hasData, navigate]);

  const handleConfirmBack = useCallback(() => {
    // Auto-save handles persistence. Just navigate.
    navigate("/");
  }, [navigate]);

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
              Transcript is preserved. Graph may not persist without cloud storage.
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
              graphData={graphData}
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
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>

      {/* Timeline ribbon */}
      {hasData && (
        <TimelineRibbon
          graphData={graphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
        />
      )}

      {/* Audio footer */}
      <div className="shrink-0 w-full py-2 px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
        <AudioInput
          onDataReceived={handleDataReceived}
          onChunksReceived={handleChunksReceived}
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
  );
}
