import { useState, useMemo, useCallback, useEffect } from "react";
import ReactFlow, { Controls, Background, MiniMap } from "reactflow";
import dagre from "dagre";
import "reactflow/dist/style.css";

// Define outside component to prevent ReactFlow warnings
const NODE_TYPES = {};
const EDGE_TYPES = {};

/**
 * ThematicView Component
 *
 * Displays AI-generated thematic nodes and their relationships using ReactFlow
 *
 * Props:
 * - thematicData: Object containing thematic_nodes and edges arrays
 * - selectedThematicNode: ID of currently selected thematic node
 * - onThematicNodeClick: Callback when a thematic node is clicked
 * - highlightedUtterances: Array of utterance IDs that are selected (to highlight parent themes)
 * - isFullScreen: Boolean for fullscreen mode
 * - setIsFullScreen: Function to toggle fullscreen mode
 */
export default function ThematicView({
  thematicData,
  selectedThematicNode,
  onThematicNodeClick,
  highlightedUtterances = [],
  isFullScreen,
  setIsFullScreen,
}) {
  const [hoveredNode, setHoveredNode] = useState(null);

  // Log prop changes for debugging
  useEffect(() => {
    console.log('[ThematicView] Props updated:');
    console.log('[ThematicView]   isFullScreen:', isFullScreen);
    console.log('[ThematicView]   setIsFullScreen exists:', !!setIsFullScreen);
    console.log('[ThematicView]   selectedThematicNode:', selectedThematicNode);
    console.log('[ThematicView]   highlightedUtterances count:', highlightedUtterances?.length);
  }, [isFullScreen, setIsFullScreen, selectedThematicNode, highlightedUtterances]);

  // Dagre Graph Configuration for auto-layout
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 120 }); // Top-to-bottom layout
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Check if a thematic node should be highlighted based on utterance selection
  const isNodeHighlightedByUtterance = useCallback(
    (nodeUtteranceIds) => {
      if (!highlightedUtterances || highlightedUtterances.length === 0) return false;
      return nodeUtteranceIds?.some((uttId) => highlightedUtterances.includes(uttId));
    },
    [highlightedUtterances]
  );

  // Format timestamp helper
  const formatTimestamp = (seconds) => {
    if (!seconds && seconds !== 0) return "";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  // Generate nodes and edges from thematic data
  const { nodes, edges } = useMemo(() => {
    console.log("[ThematicView] useMemo triggered - Input thematicData:", thematicData);
    console.log("[ThematicView] Input thematicData.edges:", thematicData?.edges);
    console.log("[ThematicView] Number of input edges:", thematicData?.edges?.length || 0);

    if (!thematicData || !thematicData.thematic_nodes) {
      console.log("[ThematicView] No thematic data or nodes - returning empty");
      return { nodes: [], edges: [] };
    }

    const thematicNodes = thematicData.thematic_nodes;
    const thematicEdges = thematicData.edges || [];
    console.log("[ThematicView] Processing", thematicNodes.length, "nodes and", thematicEdges.length, "edges");

    // Create ReactFlow nodes
    const nodes = thematicNodes.map((theme) => {
      const isSelected = selectedThematicNode === theme.id;
      const isHighlighted = isNodeHighlightedByUtterance(theme.utterance_ids);
      const isHovered = hoveredNode === theme.id;

      // Check if we're in "filtering mode" (utterances are selected)
      const isFilteringActive = highlightedUtterances && highlightedUtterances.length > 0;
      const isDimmed = isFilteringActive && !isSelected && !isHighlighted;

      let background, border, boxShadow, opacity;

      if (isSelected) {
        // Selected: Orange
        background = "#FED7AA"; // orange-200
        border = "3px solid #F97316"; // orange-500
        boxShadow = "0px 0px 20px rgba(249, 115, 22, 0.6)";
        opacity = 1;
      } else if (isHighlighted) {
        // Parent of selected utterance: Green
        background = "#BBF7D0"; // green-200
        border = "3px solid #22C55E"; // green-500
        boxShadow = "0px 0px 15px rgba(34, 197, 94, 0.5)";
        opacity = 1;
      } else if (isHovered) {
        background = "#E0E7FF"; // indigo-100
        border = "2px solid #6366F1"; // indigo-500
        boxShadow = "0px 0px 10px rgba(99, 102, 241, 0.4)";
        opacity = isDimmed ? 0.3 : 1;
      } else {
        background = "#FFFFFF";
        border = "2px solid #CBD5E1"; // slate-300
        boxShadow = "0px 2px 4px rgba(0, 0, 0, 0.1)";
        opacity = isDimmed ? 0.3 : 1;
      }

      // Get node type color accent
      const nodeTypeColors = {
        discussion: "#3B82F6", // blue-500
        claim: "#EF4444", // red-500
        worldview: "#8B5CF6", // violet-500
        normative: "#F59E0B", // amber-500
        question: "#10B981", // emerald-500
        resolution: "#06B6D4", // cyan-500
        debate: "#EC4899", // pink-500
        consensus: "#14B8A6", // teal-500
        tangent: "#6B7280", // gray-500
        default: "#6B7280", // gray-500
      };

      const nodeTypeColor = nodeTypeColors[theme.node_type] || nodeTypeColors.default;

      return {
        id: theme.id,
        data: {
          label: (
            <div className="p-2 w-[280px] h-[160px] overflow-hidden flex flex-col">
              {/* Node Type Badge */}
              <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                <span
                  className="px-2 py-0.5 text-xs font-semibold rounded-full text-white"
                  style={{ backgroundColor: nodeTypeColor }}
                >
                  {theme.node_type}
                </span>
                <span className="text-xs text-gray-500">
                  {theme.utterance_ids?.length || 0} utterances
                </span>
              </div>

              {/* Theme Label */}
              <div className="font-bold text-sm text-gray-900 mb-1 flex-shrink-0 line-clamp-2">
                {theme.label}
              </div>

              {/* Theme Summary */}
              <div className="text-xs text-gray-600 leading-relaxed flex-grow overflow-hidden line-clamp-4">
                {theme.summary}
              </div>

              {/* Timestamp Range */}
              {theme.timestamp_start !== undefined && theme.timestamp_end !== undefined && (
                <div className="text-xs text-gray-500 mt-2 font-mono flex-shrink-0">
                  {formatTimestamp(theme.timestamp_start)} - {formatTimestamp(theme.timestamp_end)}
                </div>
              )}
            </div>
          ),
        },
        position: { x: 0, y: 0 }, // Dagre will handle positioning
        style: {
          background,
          border,
          boxShadow,
          opacity,
          borderRadius: "12px",
          padding: "0",
          transition: "all 0.3s ease-in-out",
          cursor: "pointer",
        },
      };
    });

    // Create ReactFlow edges
    const edges = thematicEdges.map((edge) => {
      const isConnectedToSelected =
        selectedThematicNode === edge.source || selectedThematicNode === edge.target;

      return {
        id: `${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        label: edge.type || edge.relationship_type,
        animated: isConnectedToSelected,
        style: {
          stroke: isConnectedToSelected ? "#F97316" : "#94A3B8", // orange or slate
          strokeWidth: isConnectedToSelected ? 3 : 2,
          opacity: isConnectedToSelected ? 1 : 0.6,
          transition: "all 0.3s ease-in-out",
        },
        labelStyle: {
          fontSize: "10px",
          fontWeight: "600",
          fill: isConnectedToSelected ? "#F97316" : "#64748B",
        },
        markerEnd: {
          type: "arrowclosed",
          width: 15,
          height: 15,
          color: isConnectedToSelected ? "#F97316" : "#94A3B8",
        },
      };
    });

    // Add nodes & edges to Dagre graph for auto-layout
    nodes.forEach((node) =>
      dagreGraph.setNode(node.id, { width: 320, height: 180 })
    );
    edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

    dagre.layout(dagreGraph); // Apply layout

    // Update positions from Dagre
    const positionedNodes = nodes.map((node) => ({
      ...node,
      position: dagreGraph.node(node.id),
    }));

    // Debug logging before returning
    console.log("[ThematicView] Created", positionedNodes.length, "nodes with IDs:", positionedNodes.map(n => n.id));
    console.log("[ThematicView] Created", edges.length, "edges for ReactFlow");
    if (edges.length > 0) {
      console.log("[ThematicView] First edge:", edges[0]);
      console.log("[ThematicView] All edges:", edges.map(e => `${e.source} -> ${e.target} (${e.label})`));
    }

    return { nodes: positionedNodes, edges };
  }, [thematicData, selectedThematicNode, hoveredNode, highlightedUtterances, isNodeHighlightedByUtterance]);

  // Handle node click
  const handleNodeClick = useCallback(
    (event, node) => {
      if (onThematicNodeClick) {
        onThematicNodeClick(node.id);
      }
    },
    [onThematicNodeClick]
  );

  // Handle node hover
  const handleNodeMouseEnter = useCallback((event, node) => {
    setHoveredNode(node.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  if (!thematicData || !thematicData.thematic_nodes || thematicData.thematic_nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <p className="text-lg font-semibold mb-2">No Thematic Structure Generated</p>
        <p className="text-sm">Click "Generate Thematic View" in the Analysis menu to create one.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 px-2">
        <h3 className="text-sm font-semibold text-gray-700">
          Thematic Structure ({thematicData.thematic_nodes.length} themes, {thematicData.edges?.length || 0} connections)
        </h3>
        <div className="flex items-center gap-2">
          {thematicData.summary?.model && (
            <span className="text-xs text-gray-500">
              Model: {thematicData.summary.model.split("/").pop()}
            </span>
          )}
          {/* Fullscreen Button */}
          {setIsFullScreen && (
            <button
              className="px-3 py-1 bg-blue-100 text-blue-600 rounded-lg shadow-md hover:bg-blue-200 active:scale-95 transition text-lg"
              onClick={() => {
                console.log('[ThematicView] Fullscreen button clicked');
                console.log('[ThematicView] Current isFullScreen state:', isFullScreen);
                console.log('[ThematicView] Toggling to:', !isFullScreen);
                console.log('[ThematicView] setIsFullScreen function exists:', !!setIsFullScreen);
                setIsFullScreen(!isFullScreen);
                console.log('[ThematicView] setIsFullScreen called');
              }}
              title={isFullScreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullScreen ? "🡼" : "⛶"}
            </button>
          )}
        </div>
      </div>

      {/* ReactFlow Graph */}
      <div className="flex-grow border rounded-lg overflow-hidden bg-gray-50">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          onNodeClick={handleNodeClick}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          zoomOnPinch={true}
          zoomOnScroll={true}
          panOnDrag={true}
          panOnScroll={false}
        >
          <Controls />
          <Background color="#E5E7EB" gap={16} />
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
            style={{
              backgroundColor: "#F9FAFB",
            }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
