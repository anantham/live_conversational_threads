import { useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import FileUpload from "../components/FileUpload";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import { buildSpeakerColorMap } from "../components/graphConstants";

function isNodeObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeChunkNode(node, index, fallbackChunkId) {
  if (!isNodeObject(node)) return null;

  const chunkId =
    typeof node.chunk_id === "string" && node.chunk_id.trim()
      ? node.chunk_id.trim()
      : fallbackChunkId;

  const explicitId = typeof node.id === "string" && node.id.trim() ? node.id.trim() : "";
  const explicitName =
    typeof node.node_name === "string" && node.node_name.trim() ? node.node_name.trim() : "";
  const fallbackName =
    typeof node.summary === "string" && node.summary.trim()
      ? node.summary.trim().slice(0, 48)
      : `Node ${index + 1}`;

  return {
    ...node,
    chunk_id: chunkId,
    id: explicitId || `${chunkId}-node-${index}`,
    node_name: explicitName || fallbackName,
    edge_relations: Array.isArray(node.edge_relations) ? node.edge_relations : [],
    contextual_relation:
      node.contextual_relation && typeof node.contextual_relation === "object" && !Array.isArray(node.contextual_relation)
        ? node.contextual_relation
        : {},
  };
}

function normalizeGraphDataPayload(payload, depth = 0) {
  if (depth > 3) return null;

  // Wrapper object payloads seen in older responses: { existing_json: [...] } / { data: [...] }
  if (isNodeObject(payload)) {
    if (Array.isArray(payload.existing_json)) {
      return normalizeGraphDataPayload(payload.existing_json, depth + 1);
    }
    if (Array.isArray(payload.data)) {
      return normalizeGraphDataPayload(payload.data, depth + 1);
    }
    return null;
  }

  if (!Array.isArray(payload)) return null;
  if (payload.length === 0) return [];

  // Wrapper array shape: [{ existing_json: [...] }] or [{ data: [...] }]
  if (payload.length === 1 && isNodeObject(payload[0])) {
    if (Array.isArray(payload[0].existing_json)) {
      return normalizeGraphDataPayload(payload[0].existing_json, depth + 1);
    }
    if (Array.isArray(payload[0].data)) {
      return normalizeGraphDataPayload(payload[0].data, depth + 1);
    }
  }

  // Chunked shape: Array<Array<Node>>
  if (Array.isArray(payload[0])) {
    return payload
      .map((chunk, chunkIndex) => {
        if (!Array.isArray(chunk)) return [];
        const fallbackChunkId = `chunk-${chunkIndex}`;
        return chunk
          .map((node, index) => normalizeChunkNode(node, index, fallbackChunkId))
          .filter(Boolean);
      })
      .filter((chunk) => chunk.length > 0);
  }

  // Flat shape: Array<Node>
  if (isNodeObject(payload[0])) {
    const chunkOrder = [];
    const chunkMap = new Map();

    payload.forEach((rawNode) => {
      if (!isNodeObject(rawNode)) return;
      const chunkId =
        typeof rawNode.chunk_id === "string" && rawNode.chunk_id.trim()
          ? rawNode.chunk_id.trim()
          : "chunk-0";
      if (!chunkMap.has(chunkId)) {
        chunkMap.set(chunkId, []);
        chunkOrder.push(chunkId);
      }
      const targetChunk = chunkMap.get(chunkId);
      const normalized = normalizeChunkNode(rawNode, targetChunk.length, chunkId);
      if (normalized) {
        targetChunk.push(normalized);
      }
    });

    return chunkOrder
      .map((id) => chunkMap.get(id))
      .filter((chunk) => Array.isArray(chunk) && chunk.length > 0);
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
  const audioRef = useRef(null);

  const navigate = useNavigate();

  const latestChunk = useMemo(
    () => graphData?.[graphData.length - 1] || [],
    [graphData]
  );
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

  const handleConfirmBack = useCallback(async () => {
    await audioRef.current?.stopRecording();
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
            chunkDict={chunkDict}
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
        <div className="w-full max-w-5xl flex items-center justify-center gap-4">
          <FileUpload
            onDataReceived={handleDataReceived}
            onChunksReceived={handleChunksReceived}
            setConversationId={setConversationId}
            setFileName={setFileName}
            setMessage={setMessage}
          />
          <AudioInput
            ref={audioRef}
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
    </div>
  );
}
