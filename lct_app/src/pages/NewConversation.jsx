import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import ContextualGraph from "../components/ContextualGraph";

function normalizeGraphDataPayload(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }

  if (payload.length === 0) {
    return [];
  }

  // Legacy/expected shape: Array<Array<Node>>
  if (Array.isArray(payload[0])) {
    const normalized = payload
      .map((chunk) =>
        Array.isArray(chunk)
          ? chunk.filter((item) => item && typeof item === "object" && !Array.isArray(item))
          : []
      )
      .filter((chunk) => chunk.length > 0);
    return normalized;
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

    return chunkOrder.map((chunkId) => chunkMap.get(chunkId)).filter((chunk) => chunk.length > 0);
  }

  return null;
}

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());

  const handleDataReceived = (newData) => {
    const normalized = normalizeGraphDataPayload(newData);
    if (normalized === null) {
      console.warn(
        "[NewConversation] Ignoring malformed existing_json payload. Expected Array<Node> or Array<Array<Node>>."
      );
      return;
    }
    setGraphData(normalized);
  };

  const handleChunksReceived = (chunks) => setChunkDict(chunks);

  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-screen w-screen bg-[#fafafa]">
      {/* Minimal header — just back button */}
      <div className="absolute top-4 left-4 z-10">
        <button
          onClick={() => navigate("/")}
          className="p-2 text-gray-400 hover:text-gray-600 transition"
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Graph area */}
      <div className="flex-grow">
        <ContextualGraph
          graphData={graphData}
          chunkDict={chunkDict}
          setGraphData={setGraphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          isFullScreen={isFullScreen}
          setIsFullScreen={setIsFullScreen}
        />
      </div>

      {/* Audio footer */}
      <div className="w-full p-3 flex justify-center">
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
