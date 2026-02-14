import { useState, useMemo, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { Controls, Background } from "reactflow";
import dagre from "dagre"; // Import Dagre for auto-layout
import "reactflow/dist/style.css";
import { apiFetch } from "../services/apiClient";

// Define outside component to prevent ReactFlow warnings
const NODE_TYPES = {};
const EDGE_TYPES = {};

const EDGE_RELATION_STYLE = {
  supports: { color: "#16a34a", width: 2.8 },
  rebuts: { color: "#dc2626", width: 2.8 },
  clarifies: { color: "#2563eb", width: 2.6 },
  asks: { color: "#0f766e", width: 2.6 },
  tangent: { color: "#d97706", width: 2.6 },
  return_to_thread: { color: "#0284c7", width: 3.0 },
  contextual: { color: "#6b7280", width: 2.2 },
  temporal_next: { color: "#9ca3af", width: 2.0 },
};

// Track reference stability
console.log("[ContextualGraph] Module loaded - NODE_TYPES ref:", NODE_TYPES);
console.log("[ContextualGraph] Module loaded - EDGE_TYPES ref:", EDGE_TYPES);

// Counter to track renders
let renderCount = 0;

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
  // const [isFullScreen, setIsFullScreen] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [isClaimsPanelOpen, setIsClaimsPanelOpen] = useState(false);
  const [factCheckResults, setFactCheckResults] = useState(null);
  const [isFactChecking, setIsFactChecking] = useState(false);
  const [hoveredEdgeInfo, setHoveredEdgeInfo] = useState(null);

  const renderCountRef = useRef(0);
  const prevPropsRef = useRef({ graphData, selectedNode, isFullScreen });

  // Increment render counter
  renderCount++;
  renderCountRef.current++;

  console.log(`[ContextualGraph RENDER #${renderCount}] Component rendering`);
  console.log(`[ContextualGraph RENDER #${renderCount}] Props:`, {
    conversationId,
    graphDataLength: graphData?.length,
    selectedNode,
    isFullScreen,
    graphDataRef: graphData,
  });

  // Check if props changed
  const propsChanged = {
    graphData: prevPropsRef.current.graphData !== graphData,
    selectedNode: prevPropsRef.current.selectedNode !== selectedNode,
    isFullScreen: prevPropsRef.current.isFullScreen !== isFullScreen,
  };
  console.log(`[ContextualGraph RENDER #${renderCount}] Props changed:`, propsChanged);

  // Check NODE_TYPES and EDGE_TYPES stability
  console.log(`[ContextualGraph RENDER #${renderCount}] NODE_TYPES ref:`, NODE_TYPES);
  console.log(`[ContextualGraph RENDER #${renderCount}] EDGE_TYPES ref:`, EDGE_TYPES);

  prevPropsRef.current = { graphData, selectedNode, isFullScreen };

  const latestChunk = graphData?.[graphData.length - 1] || [];

  // Ref for transcript auto-scroll - must be at top level
  const highlightRef = useRef(null);

  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return latestChunk.find((node) => node.id === selectedNode);
  }, [selectedNode, latestChunk]);

  const selectedNodeClaims = selectedNodeData?.claims || [];

  // logging
  useEffect(() => {
    console.log("[ContextualGraph MOUNT/UPDATE] Component mounted or updated");
    console.log("Full Graph Data(contextual):", graphData);
    console.log("Latest Chunk Data(contextual):", latestChunk);

    return () => {
      console.log("[ContextualGraph CLEANUP] Component cleanup/unmount");
    };
  }, [graphData]);

  const handleFactCheck = async () => {
    if (selectedNodeClaims.length === 0) return;

    // Check for existing results first
    if (selectedNodeData?.claims_checked) {
      setFactCheckResults(selectedNodeData.claims_checked);
      return;
    }

    setIsFactChecking(true);
    setFactCheckResults(null); // Clear previous results

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

      // Update graphData to include the checked claims
      const newGraphData = graphData.map((chunk) =>
        chunk.map((node) =>
          node.id === selectedNode
            ? { ...node, claims_checked: data.claims }
            : node
        )
      );
      setGraphData(newGraphData);
    } catch (error) {
      console.error("Error during fact-checking:", error);
    } finally {
      setIsFactChecking(false);
    }
  };

  // set context from outside
  useEffect(() => {
    if (!selectedNode) {
      setShowContext(false);
      setShowTranscript(false);
      setIsClaimsPanelOpen(false);
    }
    setHoveredEdgeInfo(null);
    setFactCheckResults(null);
  }, [selectedNode]);

  // Auto-scroll to highlighted section when transcript opens
  useEffect(() => {
    if (highlightRef.current && showTranscript && selectedNode) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [showTranscript, selectedNode]);

  // Bookmark functionality - saves to database
  const handleBookmark = async () => {
    if (!selectedNode || !conversationId) return;

    const node = latestChunk.find((n) => n.id === selectedNode);
    if (!node) return;

    // If already bookmarked, delete it
    if (node.is_bookmark && node.bookmark_id) {
      try {
        const response = await apiFetch(`/api/bookmarks/${node.bookmark_id}`, {
          method: 'DELETE',
        });

        if (response.ok) {
          console.log('Bookmark deleted successfully');
          // Update local state to remove bookmark
          setGraphData((prevData) =>
            prevData.map((chunk) =>
              chunk.map((n) =>
                n.id === selectedNode
                  ? { ...n, is_bookmark: false, bookmark_id: null }
                  : n
              )
            )
          );
        } else {
          console.error('Failed to delete bookmark:', await response.text());
          alert('Failed to delete bookmark');
        }
      } catch (error) {
        console.error('Error deleting bookmark:', error);
        alert('Error deleting bookmark');
      }
    } else {
      // Create new bookmark
      try {
        const response = await apiFetch("/api/bookmarks", {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            turn_id: node.id,
            speaker_id: node.speaker_id,
            turn_summary: node.summary || node.node_name,
            full_text: node.full_text || node.summary || '',
            notes: '',
            created_by: 'anonymous',
          }),
        });

        if (response.ok) {
          const bookmark = await response.json();
          console.log('Bookmark created successfully:', bookmark);
          // Update local state to mark as bookmarked
          setGraphData((prevData) =>
            prevData.map((chunk) =>
              chunk.map((n) =>
                n.id === selectedNode
                  ? { ...n, is_bookmark: true, bookmark_id: bookmark.id }
                  : n
              )
            )
          );
        } else {
          console.error('Failed to create bookmark:', await response.text());
          alert('Failed to create bookmark');
        }
      } catch (error) {
        console.error('Error creating bookmark:', error);
        alert('Error creating bookmark');
      }
    }
  };

  // Dagre Graph Configuration
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 100 }); // Left-to-right layout
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Generate speaker colors
  const speakerColors = useMemo(() => {
    const speakers = [...new Set(latestChunk.map(item => item.speaker_id).filter(Boolean))];
    const colors = [
      "#FFB3BA", "#FFDFBA", "#FFFFBA", "#BAFFC9", "#BAE1FF",
      "#C9BAFF", "#FFBAF3", "#FFE4BA", "#E0BBE4", "#FFDAC1"
    ];
    const colorMap = {};
    speakers.forEach((speaker, idx) => {
      colorMap[speaker] = colors[idx % colors.length];
    });
    return colorMap;
  }, [latestChunk]);

  // Generate nodes and edges
  const { nodes, edges } = useMemo(() => {
    const nodes = latestChunk.map((item) => {
      let background, border, boxShadow;

      // Check if this is a turn-based utterance node
      const isUtteranceNode = item.is_utterance_node || item.speaker_id;

      if (item.is_contextual_progress) {
        // Highest priority: contextual progress
        background = "#ccffcc"; // Light Green
        border = "2px solid #33cc33"; // Green Border
        boxShadow = "0px 0px 10px rgba(51, 204, 51, 0.6)"; // Green Glow
      } else if (item.is_bookmark) {
        // Second priority: Bookmark
        background = "#cce5ff"; // Light Blue
        border = "2px solid #3399ff"; // Blue Border
        boxShadow = "0px 0px 10px rgba(51, 153, 255, 0.6)"; // Blue Glow
      } else if (selectedNode === item.id) {
        // Last priority: Selected Node
        background = "#ffcc00"; // Yellow
        border = "3px solid #ff8800"; // Orange Border
        boxShadow = "0px 0px 15px rgba(255, 136, 0, 0.8)"; // Orange Glow
      } else if (isUtteranceNode && item.speaker_id) {
        // Color by speaker for turn-based nodes
        background = speakerColors[item.speaker_id] || "white";
        border = "2px solid " + (speakerColors[item.speaker_id] ? "#666" : "#ccc");
        boxShadow = "none";
      } else {
        // Default Style
        background = "white";
        border = "1px solid #ccc";
        boxShadow = "none";
      }

      return {
        id: item.id, // ✅ Use unique ID instead of node_name
        data: {
          label: item.node_name,
          speaker: item.speaker_id // Store speaker for reference
        },
        position: { x: 0, y: 0 }, // Dagre handles positioning
        style: {
          background,
          border,
          boxShadow,
          transition: "all 0.3s ease-in-out",
          padding: "8px",
          borderRadius: "6px",
          fontSize: "12px",
        },
      };
    });
    // Build edges - temporal flow + contextual relation edges with relation typing/text
    const edges = [];

    latestChunk.forEach((item) => {
      // Temporal edges (for turn-based utterance nodes)
      if (item.successor) {
        const successorNode = latestChunk.find(n => n.id === item.successor);
        if (successorNode) {
          edges.push({
            id: `temporal-${item.id}-${successorNode.id}`, // ✅ Use unique IDs
            source: item.id, // ✅ Use unique ID
            target: successorNode.id, // ✅ Use unique ID
            animated: false,
            type: 'smoothstep',
            data: {
              relationType: "temporal_next",
              relationText: "Next in conversation order",
            },
            style: {
              stroke: "#999",
              strokeWidth: 2,
              opacity: 0.5,
            },
            markerEnd: {
              type: "arrowclosed",
              width: 8,
              height: 8,
              color: "#999",
            },
          });
        }
      }

      // Preferred contextual edges: explicit relation payloads from backend.
      const relationEntries = Array.isArray(item.edge_relations)
        ? item.edge_relations
        : [];

      if (relationEntries.length > 0) {
        relationEntries.forEach((relation, index) => {
          const relatedNodeName = relation?.related_node;
          const relatedNodeData = latestChunk.find((n) => n.node_name === relatedNodeName);
          if (!relatedNodeData) return;

          const relationType = String(relation?.relation_type || "contextual");
          const relationText = String(
            relation?.relation_text ||
              item?.contextual_relation?.[relatedNodeName] ||
              `${relatedNodeName} -> ${item.node_name}`
          );
          const style = EDGE_RELATION_STYLE[relationType] || EDGE_RELATION_STYLE.contextual;
          const isSelected = selectedNode === item.id || selectedNode === relatedNodeData.id;

          edges.push({
            id: `contextual-${relatedNodeData.id}-${item.id}-${index}`,
            source: relatedNodeData.id,
            target: item.id,
            animated: relationType !== "supports" && relationType !== "temporal_next",
            data: {
              relationType,
              relationText,
              relationSource: relatedNodeName,
            },
            style: {
              stroke: isSelected ? "#ff8800" : style.color,
              strokeWidth: isSelected ? style.width + 0.9 : style.width,
              opacity: isSelected ? 1 : 0.72,
              transition: "all 0.3s ease-in-out",
            },
            markerEnd: {
              type: "arrowclosed",
              width: 10,
              height: 10,
              color: isSelected ? "#ff8800" : style.color,
            },
          });
        });
        return;
      }

      // Backward-compatible fallback: derive contextual edges from contextual_relation map.
      Object.entries(item.contextual_relation || {}).forEach(([relatedNodeName, relationText]) => {
        const relatedNodeData = latestChunk.find((n) => n.node_name === relatedNodeName);
        if (!relatedNodeData) return;

        const isRelatedEdge = Object.keys(relatedNodeData?.contextual_relation || {}).includes(item.node_name);
        const isFormalismEdge =
          isRelatedEdge && (item.is_contextual_progress || relatedNodeData?.is_contextual_progress);
        const relationType = isFormalismEdge ? "supports" : "contextual";
        const style = EDGE_RELATION_STYLE[relationType];

        edges.push({
          id: `contextual-${relatedNodeData.id}-${item.id}`,
          source: relatedNodeData.id,
          target: item.id,
          animated: true,
          data: {
            relationType,
            relationText: String(relationText || `${relatedNodeName} -> ${item.node_name}`),
            relationSource: relatedNodeName,
          },
          style: {
            stroke: selectedNode === item.id ? "#ff8800" : style.color,
            strokeWidth: selectedNode === item.id || isFormalismEdge ? style.width + 0.8 : style.width,
            opacity: selectedNode === item.id || isFormalismEdge ? 1 : 0.65,
            transition: "all 0.3s ease-in-out",
          },
          markerEnd: {
            type: "arrowclosed",
            width: 10,
            height: 10,
            color: selectedNode === item.id ? "#ff8800" : style.color,
          },
        });
      });
    });

    // Add nodes & edges to Dagre graph
    nodes.forEach((node) =>
      dagreGraph.setNode(node.id, { width: 180, height: 50 })
    );
    edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

    dagre.layout(dagreGraph); // Apply layout

    // Update positions from Dagre
    const positionedNodes = nodes.map((node) => ({
      ...node,
      position: dagreGraph.node(node.id),
    }));

    return { nodes: positionedNodes, edges };
  }, [latestChunk, selectedNode]);

  return (
    <div
      className={`flex flex-col bg-white shadow-lg rounded-lg p-4 transition-all duration-300 ${
        isFullScreen
          ? "fixed top-0 left-0 right-0 bottom-0 w-screen h-screen z-50 overflow-hidden" // "absolute top-0 left-0 w-full h-full z-50"
          : "w-full h-full" // [calc(100%-40px)]"
      }`}
    >
      <div className="flex justify-between items-center mb-2 w-full">
        {/* Left: Claims Button */}
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

        {/* Speaker Legend - only show for turn-based graphs */}
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

        {/* Middle: Context Button */}
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
              if (!nextState) {
                setShowTranscript(false);
              }
            }
          }}

          disabled={latestChunk.length === 0 || !selectedNode}
        >
          {showContext ? "Hide  Context" : "Context"}
        </button>

        {/* Right: Fullscreen Button */}
        <button
          className="px-4 py-2 bg-blue-100 text-white rounded-lg shadow-md hover:bg-blue-200 active:scale-95 transition"
          onClick={() => setIsFullScreen(!isFullScreen)}
        >
          {isFullScreen ? "🡼" : "⛶"}
        </button>
      </div>

      {/* Context Card */}
      {showContext && selectedNode && (
        <div className="p-4 border rounded-lg bg-yellow-100 shadow-md mb-2 z-20 max-h-[200px] overflow-y-auto">
            <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              className={`px-4 py-2 rounded-lg shadow-md transition-all ${
                selectedNodeData?.is_bookmark
                  ? "bg-yellow-400 hover:bg-yellow-500 text-gray-800"
                  : "bg-gray-200 hover:bg-gray-300 text-gray-600"
              }`}
              onClick={handleBookmark}
              title={selectedNodeData?.is_bookmark ? "Remove Bookmark" : "Add Bookmark"}
            >
              {selectedNodeData?.is_bookmark
                ? "★ Bookmarked"
                : "☆ Bookmark"}
            </button>

            <button
              className="px-4 py-2 rounded-lg shadow-md bg-purple-300 hover:bg-purple-400"
              onClick={() => setShowTranscript(!showTranscript)}
            >
              {showTranscript ? "Hide transcript" : "View transcript"}
            </button>
          </div>

          <h3 className="font-semibold text-black">
            {selectedNodeData?.is_utterance_node
              ? "Utterance"
              : "Context for"}: {selectedNodeData?.node_name}
          </h3>

          {/* Show full_text for utterance nodes, otherwise show summary */}
          {selectedNodeData?.full_text ? (
            <div className="text-sm text-black">
              <strong>Speaker:</strong>{" "}
              {selectedNodeData?.speaker_id}
              <br />
              <strong>Text:</strong>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed">
                {selectedNodeData?.full_text}
              </p>
            </div>
          ) : (
            <p className="text-sm text-black">
              <strong>Summary:</strong>{" "}
              {selectedNodeData?.summary || "No summary available"}
            </p>
          )}

          {selectedNodeData?.contextual_relation &&
            Object.keys(selectedNodeData?.contextual_relation).length > 0 && (
              <>
                <h4 className="font-semibold mt-2 text-black">
                  Context drawn from:
                </h4>
                <ul className="list-disc pl-4">
                  {Object.entries(selectedNodeData?.contextual_relation).map(([key, value]) => (
                    <li key={key} className="text-sm text-black">
                      <strong>{key}:</strong> {value}
                    </li>
                  ))}
                </ul>
              </>
            )}
          {Array.isArray(selectedNodeData?.edge_relations) &&
            selectedNodeData.edge_relations.length > 0 && (
              <>
                <h4 className="font-semibold mt-2 text-black">Edge relations:</h4>
                <ul className="list-disc pl-4">
                  {selectedNodeData.edge_relations.map((relation, index) => (
                    <li key={`${relation.related_node}-${relation.relation_type}-${index}`} className="text-sm text-black">
                      <strong>{relation.relation_type || "contextual"}</strong> from{" "}
                      <strong>{relation.related_node || "unknown"}</strong>:{" "}
                      {relation.relation_text || "No description"}
                    </li>
                  ))}
                </ul>
              </>
            )}
        </div>
      )}

      {/* Transcript Card */}
      {showTranscript && selectedNode && selectedNodeData && (() => {
        const chunkId = selectedNodeData?.chunk_id;
        const transcript = chunkDict?.[chunkId] || "Transcript not available";
        const selectedTurnText = selectedNodeData?.full_text || "";

        // Split transcript into lines and find matching section
        const transcriptLines = transcript.split('\n');
        const selectedLines = selectedTurnText.split('\n');

        // Find which occurrence this turn is (to handle duplicate text)
        const currentNodeIndex = latestChunk.findIndex(n => n.id === selectedNode);
        let occurrenceNumber = 0;

        // Count how many previous turns have the same text
        for (let i = 0; i < currentNodeIndex; i++) {
          if (latestChunk[i].full_text === selectedTurnText) {
            occurrenceNumber++;
          }
        }

        // Find the Nth occurrence of this text in the transcript
        let startIndex = -1;
        let foundOccurrences = 0;
        if (selectedLines.length > 0 && selectedLines[0].trim()) {
          const searchPattern = selectedLines[0].trim().substring(0, 30);

          for (let i = 0; i < transcriptLines.length; i++) {
            if (transcriptLines[i].includes(searchPattern)) {
              if (foundOccurrences === occurrenceNumber) {
                // This is the correct occurrence!
                startIndex = i;
                break;
              }
              foundOccurrences++;
            }
          }
        }

        return (
          <div className="p-4 border rounded-lg bg-purple-100 shadow-md mb-2 z-20 max-h-[300px] overflow-y-auto">
            <h3 className="font-semibold text-black mb-2">
              Full Transcript (highlighted turn below)
            </h3>
            <div className="text-sm text-black whitespace-pre-wrap">
              {transcriptLines.map((line, index) => {
                const isHighlighted = startIndex !== -1 &&
                  index >= startIndex &&
                  index < startIndex + selectedLines.length;

                return (
                  <div
                    key={index}
                    ref={isHighlighted && index === startIndex ? highlightRef : null}
                    className={isHighlighted ? "bg-yellow-300 font-semibold p-1 rounded" : ""}
                  >
                    {line || '\u00A0'}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Claims Panel */}
      <div
        className={`
          fixed top-0 right-0 h-full bg-indigo-100 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out
          p-4 sm:p-6 overflow-y-auto w-full sm:w-1/2 lg:w-1/3
          ${isClaimsPanelOpen ? "translate-x-0" : "translate-x-full"}
        `}
      >
          <button
              onClick={() => setIsClaimsPanelOpen(false)}
              className="absolute top-4 right-4 text-gray-600 hover:text-gray-900 text-2xl"
          >
              &times;
          </button>
          <h2 className="text-xl font-bold mb-4 text-indigo-900">Claims for: {selectedNode}</h2>
          
          {selectedNodeClaims.length > 0 ? (
              <>
                  <ul className="space-y-2 mb-4 list-disc pl-5">
                      {selectedNodeClaims.map((claim, index) => (
                          <li key={index} className="text-sm text-gray-800">{claim}</li>
                      ))}
                  </ul>
                  <button
                      onClick={handleFactCheck}
                      disabled={isFactChecking}
                      className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg shadow hover:bg-blue-600 disabled:bg-blue-300"
                  >
                      {isFactChecking ? "Fact-Checking..." : `Fact Check Claims for ${selectedNode}`}
                  </button>
              </>
          ) : (
              <p>No claims were found for this node.</p>
          )}

          {isFactChecking && !factCheckResults && <p className="mt-4 text-center">Loading results...</p>}

          {factCheckResults && (
              <div className="mt-6 space-y-4">
                  <h3 className="text-lg font-bold text-indigo-800 border-b pb-2 mb-2">Fact-Check Results</h3>
                  {factCheckResults.map((result, index) => (
                      <div key={index} className="p-4 rounded-lg bg-white shadow">
                          <p className="font-semibold text-gray-800">{result.claim}</p>
                          <p className={`font-bold text-sm ${
                              result.verdict === 'True' ? 'text-green-700' : 
                              result.verdict === 'False' ? 'text-red-700' : 'text-yellow-600'
                          }`}>Verdict: {result.verdict}</p>
                          <p className="mt-2 text-sm text-gray-600">{result.explanation}</p>
                          {result.citations.length > 0 && (
                              <div className="mt-2">
                                  <h4 className="font-semibold text-xs text-gray-500 uppercase tracking-wider">Sources:</h4>
                                  <ul className="list-disc pl-5 space-y-1 mt-1">
                                      {result.citations.map((cite, i) => (
                                          <li key={i} className="text-sm">
                                              <a href={cite.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                                                  {cite.title}
                                              </a>
                                          </li>
                                      ))}
                                  </ul>
                              </div>
                          )}
                      </div>
                  ))}
              </div>
          )}
      </div>

      <div className="relative flex-grow border rounded-lg overflow-hidden">
        {hoveredEdgeInfo && (
          <div className="absolute right-6 top-28 z-30 max-w-md rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-900 shadow">
            <p className="font-semibold">
              Edge: {hoveredEdgeInfo.relationType || "contextual"}
            </p>
            <p>{hoveredEdgeInfo.relationText || "No relation detail available."}</p>
          </div>
        )}
        {/* Show raw transcript when no nodes exist yet */}
        {latestChunk.length === 0 && chunkDict && Object.keys(chunkDict).length > 0 ? (
          <div className="h-full p-6 overflow-y-auto bg-gray-50">
            <div className="max-w-4xl mx-auto">
              <div className="mb-4 p-4 bg-blue-50 border-l-4 border-blue-400 rounded">
                <p className="text-sm text-blue-800">
                  📝 <strong>Raw Transcript View</strong> - This conversation has not been analyzed yet.
                  The transcript is displayed below. Use analysis tools to generate nodes and insights.
                </p>
              </div>
              <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4 text-gray-800">Conversation Transcript</h3>
                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {Object.values(chunkDict).join('\n\n')}
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
             // 🔍 Zoom Controls
            zoomOnPinch={true}
            zoomOnScroll={true}

            // 🖱️ Pan Controls
            panOnDrag={true}
            panOnScroll={false}
            onNodeClick={(_, node) =>
            setSelectedNode((prevSelected) => {
              const isDeselecting = prevSelected === node.id;
              if (isDeselecting) setShowContext(false); // Reset context on deselect
              if (isDeselecting) setShowTranscript(false); // Reset context on deselect
              return isDeselecting ? null : node.id;
            })
            } // Sync selection
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
