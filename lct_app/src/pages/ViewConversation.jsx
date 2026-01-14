import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
// import Input from "./components/Input";
// import AudioInput from "../components/AudioInput";
import StructuralGraph from "../components/StructuralGraph";
import ContextualGraph from "../components/ContextualGraph";
import HorizontalTimeline from "../components/HorizontalTimeline";
import ThematicView from "../components/ThematicView";
// import SaveJson from "../components/SaveJson";
import SaveTranscript from "../components/SaveTranscript";
import ExportCanvas from "../components/ExportCanvas";
import Legend from "../components/Legend";
import GenerateFormalism from "../components/GenerateFormalism";
import FormalismList from "../components/FormalismList";

export default function ViewConversation() {
  const [graphData, setGraphData] = useState([]); // Stores graph data
  const [selectedNode, setSelectedNode] = useState(null); // Tracks selected node
  const [chunkDict, setChunkDict] = useState({}); // Stores chunk data
  const [isFormalismView, setIsFormalismView] = useState(false); // stores layout state: formalism or browsability
  const [selectedFormalism, setSelectedFormalism] = useState(null); // stores selected formalism
  const [formalismData, setFormalismData] = useState({}); // Stores Formalism data
  const [selectedLoopyURL, setSelectedLoopyURL] = useState(""); // Stores Loopy URL
  // const [message, setMessage] = useState(""); // message for saving conversation
  const [isFullScreen, setIsFullScreen] = useState(false); // full screen status
  const [conversationName, setConversationName] = useState(""); // Stores conversation name for export

  // Thematic Analysis State
  const [isGeneratingThemes, setIsGeneratingThemes] = useState(false);
  const [thematicData, setThematicData] = useState(null); // Stores thematic nodes and edges
  const [utterances, setUtterances] = useState([]); // Stores all utterances for timeline
  const [selectedThematicNode, setSelectedThematicNode] = useState(null); // Selected thematic node ID
  const [selectedUtteranceIds, setSelectedUtteranceIds] = useState([]); // Selected utterance IDs
  const [isThematicViewActive, setIsThematicViewActive] = useState(false); // Toggle thematic view

const { conversationId } = useParams();

const navigate = useNavigate();

const API_URL = import.meta.env.VITE_API_URL || "";

useEffect(() => {
  if (!conversationId) return;

  console.log("[ViewConversation] Loading conversation:", conversationId);

  // Load conversation data
  fetch(`${API_URL}/conversations/${conversationId}`)
    .then((res) => {
      console.log("[ViewConversation] Fetch response status:", res.status);
      return res.json();
    })
    .then((data) => {
      console.log("[ViewConversation] Received data:", data);
      console.log("[ViewConversation] graph_data:", data.graph_data);
      console.log("[ViewConversation] chunk_dict:", data.chunk_dict);

      if (data.graph_data) {
        console.log("[ViewConversation] Setting graphData with", data.graph_data.length, "nodes");
        setGraphData(data.graph_data);
      }
      if (data.chunk_dict) {
        console.log("[ViewConversation] Setting chunkDict with", Object.keys(data.chunk_dict).length, "chunks");
        setChunkDict(data.chunk_dict);
      }
    })
    .catch((err) => {
      console.error("[ViewConversation] Failed to load conversation:", err);
    });

  // Load conversation metadata for name
  fetch(`${API_URL}/conversations/`)
    .then((res) => res.json())
    .then((conversations) => {
      console.log("[ViewConversation] Loaded conversations list:", conversations);
      // FIX: Backend returns 'file_id', not 'id'
      const conversation = conversations.find((c) => c.file_id === conversationId);
      console.log("[ViewConversation] Found conversation:", conversation);
      if (conversation) {
        setConversationName(conversation.file_name);
      }
    })
    .catch((err) => {
      console.error("[ViewConversation] Failed to load conversation metadata:", err);
    });
}, [conversationId]);

useEffect(() => {
  console.log('[ViewConversation] Initial mount - setting isFullScreen to true');
  setIsFullScreen(true); // Trigger fullscreen on load
}, []);

// Track isFullScreen state changes
useEffect(() => {
  console.log('[ViewConversation] isFullScreen state changed to:', isFullScreen);
}, [isFullScreen]);

// Fetch utterances for timeline
useEffect(() => {
  if (!conversationId) return;

  console.log("[ViewConversation] Loading utterances for conversation:", conversationId);

  fetch(`${API_URL}/api/conversations/${conversationId}/utterances`)
    .then((res) => res.json())
    .then((data) => {
      console.log("[ViewConversation] Loaded utterances:", data.total);
      setUtterances(data.utterances || []);
    })
    .catch((err) => {
      console.error("[ViewConversation] Failed to load utterances:", err);
    });
}, [conversationId]);

// Fetch existing thematic structure on load
useEffect(() => {
  if (!conversationId) return;

  console.log("[ViewConversation] Checking for existing thematic structure");

  fetch(`${API_URL}/api/conversations/${conversationId}/themes`)
    .then((res) => res.json())
    .then((data) => {
      if (data.summary?.exists && data.thematic_nodes?.length > 0) {
        console.log("[ViewConversation] Found existing thematic structure:", data);
        console.log("[ViewConversation] Edges from API:", data.edges);
        console.log("[ViewConversation] Number of edges:", data.edges?.length || 0);
        if (data.edges && data.edges.length > 0) {
          console.log("[ViewConversation] First edge details:", data.edges[0]);
        }
        setThematicData(data);
      }
    })
    .catch((err) => {
      console.error("[ViewConversation] Failed to check for thematic structure:", err);
    });
}, [conversationId]);

// Handler: Generate Thematic View
const handleGenerateThematicView = async () => {
  if (!conversationId) return;

  setIsGeneratingThemes(true);

  try {
    console.log("[Thematic] Generating thematic structure for conversation:", conversationId);

    const response = await fetch(
      `${API_URL}/api/conversations/${conversationId}/themes/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to generate themes: ${response.statusText}`);
    }

    const data = await response.json();
    console.log("[Thematic] Generated thematic structure:", data);
    console.log("[Thematic] Edges from API:", data.edges);
    console.log("[Thematic] Number of edges:", data.edges?.length || 0);
    if (data.edges && data.edges.length > 0) {
      console.log("[Thematic] First edge details:", data.edges[0]);
    }

    setThematicData(data);
    setIsThematicViewActive(true); // Activate thematic view
    alert(`Successfully generated ${data.thematic_nodes?.length || 0} thematic nodes!`);

  } catch (error) {
    console.error("[Thematic] Error generating themes:", error);
    alert(`Error generating thematic view: ${error.message}`);
  } finally {
    setIsGeneratingThemes(false);
  }
};

// Handler: Thematic Node Click (bidirectional selection)
const handleThematicNodeClick = (nodeId) => {
  console.log("[Thematic] Clicked thematic node:", nodeId);

  // Toggle selection
  if (selectedThematicNode === nodeId) {
    setSelectedThematicNode(null);
    setSelectedUtteranceIds([]);
  } else {
    setSelectedThematicNode(nodeId);

    // Find the thematic node and get its utterance IDs
    const node = thematicData?.thematic_nodes?.find(n => n.id === nodeId);
    if (node && node.utterance_ids) {
      setSelectedUtteranceIds(node.utterance_ids);
    }
  }
};

// Handler: Utterance Click (bidirectional selection)
const handleUtteranceClick = (utterance) => {
  console.log("[Thematic] Clicked utterance:", utterance.id);

  // Toggle utterance selection
  if (selectedUtteranceIds.includes(utterance.id)) {
    // Deselect this utterance
    setSelectedUtteranceIds([]);
    setSelectedThematicNode(null);
  } else {
    // Select this utterance (this will highlight ALL parent thematic nodes)
    setSelectedUtteranceIds([utterance.id]);
    // Don't set selectedThematicNode - let all parent nodes be highlighted instead
    setSelectedThematicNode(null);
  }
};

  return (
    <div className="flex flex-col h-screen w-screen bg-gradient-to-br from-blue-500 to-purple-600 text-white">
      {/* Header - Hidden when in fullscreen thematic view */}
      {!(isFullScreen && isThematicViewActive) && (
        <div className="w-full px-4 py-4 bg-transparent flex flex-row justify-between items-start md:grid md:grid-cols-3 md:items-center gap-2">
        {/* Left: Back Button & Analysis Menu */}
        <div className="w-full md:w-auto flex justify-start gap-2">
          <button
            onClick={() => navigate("/browse")}
            className="px-4 py-2 h-10 bg-white text-blue-600 font-semibold rounded-lg shadow hover:bg-blue-100 transition text-sm md:text-base"
          >
            ⬅ Back
          </button>

          {/* Analysis Dropdown */}
          <div className="relative group">
            <button
              className="px-4 py-2 h-10 bg-purple-500 text-white font-semibold rounded-lg shadow hover:bg-purple-600 transition text-sm md:text-base"
            >
              Analysis 📊
            </button>

            {/* Dropdown Menu */}
            <div className="absolute left-0 mt-2 w-56 bg-white rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
              <div className="py-2">
                <button
                  onClick={() => navigate(`/analytics/${conversationId}`)}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-purple-50 hover:text-purple-600 transition"
                >
                  📈 Speaker Analytics
                </button>
                <button
                  onClick={() => navigate(`/edit-history/${conversationId}`)}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-purple-50 hover:text-purple-600 transition"
                >
                  📝 Edit History
                </button>
                <hr className="my-2 border-gray-200" />
                <div className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase">
                  AI Analysis (Weeks 11-13)
                </div>
                <button
                  onClick={() => navigate(`/simulacra/${conversationId}`)}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition"
                >
                  🎭 Simulacra Levels
                </button>
                <button
                  onClick={() => navigate(`/biases/${conversationId}`)}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-orange-50 hover:text-orange-600 transition"
                >
                  🧠 Cognitive Biases
                </button>
                <button
                  onClick={() => navigate(`/frames/${conversationId}`)}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-green-50 hover:text-green-600 transition"
                >
                  🔍 Implicit Frames
                </button>
                <button
                  onClick={handleGenerateThematicView}
                  disabled={isGeneratingThemes}
                  className={`w-full text-left px-4 py-2 transition ${
                    isGeneratingThemes
                      ? 'text-gray-400 cursor-wait'
                      : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                  }`}
                >
                  {isGeneratingThemes ? '⏳ Generating...' : '🎨 Generate Thematic View'}
                </button>
                {thematicData && thematicData.thematic_nodes?.length > 0 && (
                  <button
                    onClick={() => setIsThematicViewActive(!isThematicViewActive)}
                    className="w-full text-left px-4 py-2 text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 transition"
                  >
                    {isThematicViewActive ? '👁️ Hide Thematic View' : '👁️ Show Thematic View'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Center: GenerateFormalism Buttons */}
        <div className="w-full md:w-auto flex justify-end md:justify-center">
          <div className="flex flex-col md:flex-row items-end md:items-center gap-2">
            <GenerateFormalism
              chunkDict={chunkDict}
              graphData={graphData}
              isFormalismView={isFormalismView}
              setIsFormalismView={setIsFormalismView}
              formalismData={formalismData}
              setFormalismData={setFormalismData}
            />
          </div>
        </div>

        {/* Right: Export Actions (desktop only) */}
        {graphData.length > 0 && (
          <div className="hidden md:flex justify-end w-full gap-2">
            <SaveTranscript chunkDict={chunkDict} />
            <ExportCanvas graphData={graphData} fileName={conversationName} />
          </div>
        )}
        </div>
      )}

      {!isFormalismView ? (
        // Check if thematic view is active
        isThematicViewActive && thematicData ? (
          // 🎨 Thematic View Layout (ThematicView + HorizontalTimeline)
          <div className={`flex-grow flex flex-col w-full h-screen ${isFullScreen ? 'p-0' : 'p-6 space-y-6'}`}>
            {/* Top: Thematic Nodes Graph - Takes full height when fullscreen, 2/3 otherwise */}
            <div className={`bg-white w-full flex flex-col ${isFullScreen ? 'flex-grow h-full' : 'flex-grow-[2] rounded-lg shadow-lg p-4'}`}>
              <ThematicView
                thematicData={thematicData}
                selectedThematicNode={selectedThematicNode}
                onThematicNodeClick={handleThematicNodeClick}
                highlightedUtterances={selectedUtteranceIds}
                isFullScreen={isFullScreen}
                setIsFullScreen={setIsFullScreen}
                conversationId={conversationId}
                utterances={utterances}
                onUtteranceClick={handleUtteranceClick}
              />
            </div>

            {/* Bottom: Horizontal Timeline - Hidden when fullscreen, 1/3 height otherwise */}
            {!isFullScreen && (
              <div className="flex-grow bg-white rounded-lg shadow-lg p-4 w-full overflow-hidden flex flex-col">
                <HorizontalTimeline
                  conversationId={conversationId}
                  utterances={utterances}
                  selectedUtteranceIds={selectedUtteranceIds}
                  onUtteranceClick={handleUtteranceClick}
                  highlightedThematicNodes={selectedThematicNode ? [selectedThematicNode] : []}
                  selectedThematicNodeUtterances={
                    // Get full utterance objects for the selected thematic node
                    selectedUtteranceIds.length > 0
                      ? utterances.filter(utt => selectedUtteranceIds.includes(utt.id))
                      : []
                  }
                />
              </div>
            )}
          </div>
        ) : (
          // 🔵 Default layout (Contextual + Structural)
          <div className="flex-grow flex flex-col p-6 w-full h-screen space-y-6">

            {/* 🟣 Contextual Flow - 3/4 height */}
            <div className="flex-grow-[4] bg-white rounded-lg shadow-lg p-4 w-full overflow-hidden flex flex-col">
              <ContextualGraph
                  conversationId={conversationId}
                  graphData={graphData}
                  chunkDict={chunkDict}
                  setGraphData={setGraphData}
                  selectedNode={selectedNode}
                  setSelectedNode={setSelectedNode}
                  isFullScreen={isFullScreen}
                  setIsFullScreen={setIsFullScreen}
                />
            </div>

            {/* 🎨 Horizontal Timeline - 1/4 height */}
            <div className="flex-grow bg-white rounded-lg shadow-lg p-4 w-full overflow-hidden flex flex-col">
              <HorizontalTimeline
                conversationId={conversationId}
                utterances={utterances}
                selectedUtteranceIds={selectedUtteranceIds}
                onUtteranceClick={handleUtteranceClick}
                highlightedThematicNodes={[]}
                selectedThematicNodeUtterances={
                  selectedUtteranceIds.length > 0
                    ? utterances.filter(utt => selectedUtteranceIds.includes(utt.id))
                    : []
                }
              />
            </div>
          </div>
        )
      ) : (
        // 🟣 Formalism layout
        <div className="flex-grow flex flex-col space-y-4 p-4 md:p-6">
          {/* Top Section */}
          <div className="flex flex-col md:flex-row md:space-x-4 space-y-4 md:space-y-0 md:h-2/5">
            {/* Top Left - Formalism List */}
            <div className="w-full md:w-1/2 bg-white rounded-lg shadow-lg p-4">
              <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
                Generated Formalisms
              </h2>
              <FormalismList
                selectedFormalism={selectedFormalism}
                setSelectedFormalism={setSelectedFormalism}
                formalismData={formalismData}
                setFormalismData={setFormalismData}
                setSelectedLoopyURL={setSelectedLoopyURL}
              />
            </div>

            {/* Top Right - Contextual Graph */}
            <div className="hidden md:block w-full md:w-1/2 bg-white rounded-lg shadow-lg p-4">
              <ContextualGraph
                conversationId={conversationId}
                graphData={graphData}
                chunkDict={chunkDict}
                setGraphData={setGraphData}
                selectedNode={selectedNode}
                setSelectedNode={setSelectedNode}
                isFullScreen={isFullScreen}
                setIsFullScreen={setIsFullScreen}
              />
            </div>
          </div>

          {/* Bottom - Canvas */}
          <div className="bg-white rounded-lg shadow-lg p-4 flex flex-col flex-grow">
            <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
              Formalism Model Diagram
            </h2>

            <div className="flex-1 flex items-center justify-center">
              <button
                onClick={() => {
                  const url = selectedLoopyURL || "https://ncase.me/loopy/";
                  window.open(url, "_blank");
                }}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg shadow hover:bg-blue-700 transition-colors"
              >
                {selectedLoopyURL ? "View Model" : "Open Loopy Editor"}
              </button>
            </div>
          </div>
        </div>
      )}

      {!isFormalismView && (
        <>

          {/* Legend - moved to bottom-left, collapsible */}
          <div className="hidden md:block">
            <Legend position="bottom-left" />
          </div>
        </>
      )}
    </div>
  );
}
