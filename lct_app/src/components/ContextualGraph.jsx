import { useState, useMemo, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { Controls, Background } from "reactflow";
import "reactflow/dist/style.css";
import { apiFetch } from "../services/apiClient";

import { graphDebugLog } from "./contextual/contextualGraphUtils";
import useContextualGraphLayout from "./contextual/useContextualGraphLayout";
import ContextCard from "./contextual/ContextCard";
import TranscriptCard from "./contextual/TranscriptCard";
import ClaimsPanel from "./contextual/ClaimsPanel";

// Defined outside component to prevent ReactFlow warnings
const NODE_TYPES = {};
const EDGE_TYPES = {};

export default function ContextualGraph({
  conversationId,
  graphData,
  chunkDict,
  setGraphData,
  selectedNode,
  setSelectedNode,
  isFullScreen,
  setIsFullScreen,
}) {
  const [showContext, setShowContext] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [isClaimsPanelOpen, setIsClaimsPanelOpen] = useState(false);
  const [factCheckResults, setFactCheckResults] = useState(null);
  const [isFactChecking, setIsFactChecking] = useState(false);
  const [hoveredEdgeInfo, setHoveredEdgeInfo] = useState(null);

  const prevPropsRef = useRef({ graphData, selectedNode, isFullScreen });

  graphDebugLog("[ContextualGraph RENDER] Props:", {
    conversationId,
    graphDataLength: graphData?.length,
    selectedNode,
    isFullScreen,
  });
  graphDebugLog("[ContextualGraph RENDER] Props changed:", {
    graphData: prevPropsRef.current.graphData !== graphData,
    selectedNode: prevPropsRef.current.selectedNode !== selectedNode,
    isFullScreen: prevPropsRef.current.isFullScreen !== isFullScreen,
  });
  prevPropsRef.current = { graphData, selectedNode, isFullScreen };

  const latestChunk = graphData?.[graphData.length - 1] || [];

  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return latestChunk.find((node) => node.id === selectedNode);
  }, [selectedNode, latestChunk]);

  const selectedNodeClaims = selectedNodeData?.claims || [];

  useEffect(() => {
    graphDebugLog("[ContextualGraph MOUNT/UPDATE]");
    graphDebugLog("Full Graph Data(contextual):", graphData);
    graphDebugLog("Latest Chunk Data(contextual):", latestChunk);
    return () => graphDebugLog("[ContextualGraph CLEANUP]");
  }, [graphData]);

  // Reset UI state when selected node changes
  useEffect(() => {
    if (!selectedNode) {
      setShowContext(false);
      setShowTranscript(false);
      setIsClaimsPanelOpen(false);
    }
    setHoveredEdgeInfo(null);
    setFactCheckResults(null);
  }, [selectedNode]);

  const handleFactCheck = async () => {
    if (selectedNodeClaims.length === 0) return;

    if (selectedNodeData?.claims_checked) {
      setFactCheckResults(selectedNodeData.claims_checked);
      return;
    }

    setIsFactChecking(true);
    setFactCheckResults(null);

    try {
      const response = await apiFetch("/fact_check_claims/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claims: selectedNodeClaims }),
      });

      if (!response.ok) {
        throw new Error(`Fact-check failed: ${response.statusText}`);
      }

      const data = await response.json();
      setFactCheckResults(data.claims);

      setGraphData(
        graphData.map((chunk) =>
          chunk.map((node) =>
            node.id === selectedNode ? { ...node, claims_checked: data.claims } : node
          )
        )
      );
    } catch (error) {
      console.error("Error during fact-checking:", error);
    } finally {
      setIsFactChecking(false);
    }
  };

  const handleBookmark = async () => {
    if (!selectedNode || !conversationId) return;

    const node = latestChunk.find((n) => n.id === selectedNode);
    if (!node) return;

    if (node.is_bookmark && node.bookmark_id) {
      try {
        const response = await apiFetch(`/api/bookmarks/${node.bookmark_id}`, {
          method: "DELETE",
        });
        if (response.ok) {
          setGraphData((prevData) =>
            prevData.map((chunk) =>
              chunk.map((n) =>
                n.id === selectedNode ? { ...n, is_bookmark: false, bookmark_id: null } : n
              )
            )
          );
        } else {
          console.error("Failed to delete bookmark:", await response.text());
          alert("Failed to delete bookmark");
        }
      } catch (error) {
        console.error("Error deleting bookmark:", error);
        alert("Error deleting bookmark");
      }
    } else {
      try {
        const response = await apiFetch("/api/bookmarks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversationId,
            turn_id: node.id,
            speaker_id: node.speaker_id,
            turn_summary: node.summary || node.node_name,
            full_text: node.full_text || node.summary || "",
            notes: "",
            created_by: "anonymous",
          }),
        });
        if (response.ok) {
          const bookmark = await response.json();
          setGraphData((prevData) =>
            prevData.map((chunk) =>
              chunk.map((n) =>
                n.id === selectedNode ? { ...n, is_bookmark: true, bookmark_id: bookmark.id } : n
              )
            )
          );
        } else {
          console.error("Failed to create bookmark:", await response.text());
          alert("Failed to create bookmark");
        }
      } catch (error) {
        console.error("Error creating bookmark:", error);
        alert("Error creating bookmark");
      }
    }
  };

  const { nodes, edges, speakerColors } = useContextualGraphLayout({ latestChunk, selectedNode });

  return (
    <div
      className={`flex flex-col bg-white shadow-lg rounded-lg p-4 transition-all duration-300 ${
        isFullScreen
          ? "fixed top-0 left-0 right-0 bottom-0 w-screen h-screen z-50 overflow-hidden"
          : "w-full h-full"
      }`}
    >
      {/* Toolbar */}
      <div className="flex justify-between items-center mb-2 w-full">
        <button
          className={`px-4 py-2 rounded-lg shadow-md transition active:scale-95 ${
            selectedNodeClaims.length > 0
              ? "bg-indigo-300 hover:bg-indigo-400"
              : "bg-gray-300 cursor-not-allowed"
          }`}
          onClick={() => setIsClaimsPanelOpen(true)}
          disabled={selectedNodeClaims.length === 0}
        >
          Claims
        </button>

        {/* Speaker legend */}
        {latestChunk.length > 0 && latestChunk[0]?.speaker_id && (
          <div className="flex gap-2 items-center text-xs">
            {Object.entries(speakerColors).map(([speaker, color]) => (
              <div key={speaker} className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded-full border border-gray-600"
                  style={{ backgroundColor: color }}
                />
                <span className="text-gray-700 font-medium">{speaker}</span>
              </div>
            ))}
          </div>
        )}

        <button
          className={`px-4 py-2 rounded-lg shadow-md transition active:scale-95 ${
            latestChunk.length > 0 && selectedNode
              ? "bg-yellow-300 hover:bg-yellow-400"
              : "bg-gray-300 cursor-not-allowed"
          }`}
          onClick={() => {
            if (latestChunk.length > 0 && selectedNode) {
              const nextState = !showContext;
              setShowContext(nextState);
              if (!nextState) setShowTranscript(false);
            }
          }}
          disabled={latestChunk.length === 0 || !selectedNode}
        >
          {showContext ? "Hide  Context" : "Context"}
        </button>

        <button
          className="px-4 py-2 bg-blue-100 text-white rounded-lg shadow-md hover:bg-blue-200 active:scale-95 transition"
          onClick={() => setIsFullScreen(!isFullScreen)}
        >
          {isFullScreen ? "🡼" : "⛶"}
        </button>
      </div>

      {/* Context card */}
      {showContext && selectedNode && (
        <ContextCard
          selectedNodeData={selectedNodeData}
          showTranscript={showTranscript}
          onBookmark={handleBookmark}
          onToggleTranscript={() => setShowTranscript((v) => !v)}
        />
      )}

      {/* Transcript card */}
      {showTranscript && selectedNode && selectedNodeData && (
        <TranscriptCard
          selectedNode={selectedNode}
          selectedNodeData={selectedNodeData}
          chunkDict={chunkDict}
          latestChunk={latestChunk}
        />
      )}

      {/* Claims sliding panel */}
      <ClaimsPanel
        isOpen={isClaimsPanelOpen}
        onClose={() => setIsClaimsPanelOpen(false)}
        selectedNode={selectedNode}
        selectedNodeClaims={selectedNodeClaims}
        isFactChecking={isFactChecking}
        onFactCheck={handleFactCheck}
        factCheckResults={factCheckResults}
      />

      {/* Graph canvas */}
      <div className="relative flex-grow border rounded-lg overflow-hidden">
        {hoveredEdgeInfo && (
          <div className="absolute right-6 top-28 z-30 max-w-md rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-900 shadow">
            <p className="font-semibold">Edge: {hoveredEdgeInfo.relationType || "contextual"}</p>
            <p>{hoveredEdgeInfo.relationText || "No relation detail available."}</p>
          </div>
        )}

        {latestChunk.length === 0 && chunkDict && Object.keys(chunkDict).length > 0 ? (
          <div className="h-full p-6 overflow-y-auto bg-gray-50">
            <div className="max-w-4xl mx-auto">
              <div className="mb-4 p-4 bg-blue-50 border-l-4 border-blue-400 rounded">
                <p className="text-sm text-blue-800">
                  📝 <strong>Raw Transcript View</strong> — This conversation has not been analyzed
                  yet. Use analysis tools to generate nodes and insights.
                </p>
              </div>
              <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4 text-gray-800">
                  Conversation Transcript
                </h3>
                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {Object.values(chunkDict).join("\n\n")}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            zoomOnPinch
            zoomOnScroll
            panOnDrag
            panOnScroll={false}
            onNodeClick={(_, node) =>
              setSelectedNode((prevSelected) => {
                const isDeselecting = prevSelected === node.id;
                if (isDeselecting) {
                  setShowContext(false);
                  setShowTranscript(false);
                }
                return isDeselecting ? null : node.id;
              })
            }
            onEdgeMouseEnter={(_, edge) =>
              setHoveredEdgeInfo({
                relationType: edge?.data?.relationType || "contextual",
                relationText: edge?.data?.relationText || "",
              })
            }
            onEdgeMouseLeave={() => setHoveredEdgeInfo(null)}
          >
            <Controls />
            <Background />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

ContextualGraph.propTypes = {
  conversationId: PropTypes.string,
  graphData: PropTypes.arrayOf(
    PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.string,
        node_name: PropTypes.string.isRequired,
        node_text: PropTypes.string,
        source_excerpt: PropTypes.string,
        thread_id: PropTypes.string,
        thread_state: PropTypes.string,
        claims: PropTypes.arrayOf(PropTypes.string),
        is_contextual_progress: PropTypes.bool,
        is_bookmark: PropTypes.bool,
        summary: PropTypes.string,
        contextual_relation: PropTypes.object,
        edge_relations: PropTypes.arrayOf(
          PropTypes.shape({
            related_node: PropTypes.string,
            relation_type: PropTypes.string,
            relation_text: PropTypes.string,
          })
        ),
        chunk_id: PropTypes.string,
        conversation_id: PropTypes.string,
        claims_checked: PropTypes.array,
      })
    )
  ),
  chunkDict: PropTypes.object,
  setGraphData: PropTypes.func.isRequired,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
  isFullScreen: PropTypes.bool.isRequired,
  setIsFullScreen: PropTypes.func.isRequired,
};
