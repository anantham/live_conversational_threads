import { useMemo, useCallback } from "react";
import dagre from "dagre";
import { NODE_TYPE_COLORS, FONT_SIZE_CLASSES, formatTimestamp } from "./thematicConstants";

/**
 * Generates ReactFlow nodes/edges from thematic data using dagre layout,
 * and computes selected-node derived state.
 *
 * @param {object} params
 * @param {object} params.activeData - Thematic data for current level
 * @param {number} params.currentLevel - Current display level
 * @param {string|null} params.selectedThematicNode - ID of selected node
 * @param {string|null} params.hoveredNode - ID of hovered node
 * @param {string[]} params.highlightedUtterances - Utterance IDs highlighted by parent
 * @param {string} params.fontSize - 'small' | 'normal' | 'large'
 * @param {object[]} params.utterances - All utterances for utterance detail lookup
 * @returns {{ nodes, edges, selectedNodeData, selectedNodeUtterances }}
 */
export function useThematicGraph({
  activeData,
  currentLevel,
  selectedThematicNode,
  hoveredNode,
  highlightedUtterances = [],
  fontSize = 'normal',
  utterances = [],
}) {
  // Check if a thematic node should be highlighted based on utterance selection
  const isNodeHighlightedByUtterance = useCallback(
    (nodeUtteranceIds) => {
      if (!highlightedUtterances || highlightedUtterances.length === 0) return false;
      return nodeUtteranceIds?.some((uttId) => highlightedUtterances.includes(uttId));
    },
    [highlightedUtterances]
  );

  const fontSizeClasses = FONT_SIZE_CLASSES[fontSize] || FONT_SIZE_CLASSES.normal;

  // Generate nodes and edges from thematic data
  const { nodes, edges } = useMemo(() => {
    console.log(`[ThematicView] useMemo triggered - Level ${currentLevel}`);
    console.log("[ThematicView] Active data:", activeData);
    console.log("[ThematicView] DIAGNOSTIC - activeData.edges:", activeData?.edges);
    console.log("[ThematicView] DIAGNOSTIC - typeof activeData.edges:", typeof activeData?.edges);
    console.log("[ThematicView] DIAGNOSTIC - Array.isArray(activeData.edges):", Array.isArray(activeData?.edges));

    if (!activeData || !activeData.thematic_nodes) {
      console.log("[ThematicView] No thematic data or nodes - returning empty");
      return { nodes: [], edges: [] };
    }

    const thematicNodes = activeData.thematic_nodes;
    const thematicEdges = activeData.edges || [];

    // FIXED: Create dagre graph INSIDE useMemo to prevent stale reference issues
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setGraph({ rankdir: "TB", nodesep: 140, ranksep: 200 });
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    console.log(`[ThematicView] Level ${currentLevel}: Processing`, thematicNodes.length, "nodes and", thematicEdges.length, "edges");

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

      const nodeTypeColor = NODE_TYPE_COLORS[theme.node_type] || NODE_TYPE_COLORS.default;

      return {
        id: theme.id,
        data: {
          label: (
            <div className="p-3 flex flex-col gap-1" style={{ width: '280px', maxHeight: '180px', overflow: 'hidden' }}>
              {/* Node Type Badge */}
              <div className="flex items-center gap-2 mb-1 flex-shrink-0">
                <span
                  className={`px-2 py-0.5 ${fontSizeClasses.badge} font-semibold rounded-full text-white`}
                  style={{ backgroundColor: nodeTypeColor, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {theme.node_type}
                </span>
                <span className={`${fontSizeClasses.badge} text-gray-500 flex-shrink-0`}>
                  {theme.utterance_ids?.length || 0} utt
                </span>
              </div>

              {/* Theme Label */}
              <div
                className={`font-bold ${fontSizeClasses.label} text-gray-900 mb-1 flex-shrink-0`}
                style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
              >
                {theme.label}
              </div>

              {/* Theme Summary */}
              <div
                className={`${fontSizeClasses.summary} text-gray-600 leading-relaxed flex-grow`}
                style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
              >
                {theme.summary}
              </div>

              {/* Timestamp Range */}
              {theme.timestamp_start !== undefined && theme.timestamp_end !== undefined && (
                <div className="text-xs text-gray-500 mt-1 font-mono flex-shrink-0">
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
          width: "300px",
          maxHeight: "200px",
          overflow: "hidden",
          transition: "all 0.3s ease-in-out",
          cursor: "pointer",
        },
      };
    });

    // Create ReactFlow edges
    const edges = thematicEdges.map((edge) => {
      const isConnectedToSelected =
        selectedThematicNode === edge.source || selectedThematicNode === edge.target;

      const edgeType = (edge.type || edge.relationship_type || "").toLowerCase();
      const isSupportive = ["supports", "affirms", "enables", "informs", "builds_on"].some(t => edgeType.includes(t));
      const isContradictory = ["contradicts", "opposes", "refutes", "challenges", "conflicts"].some(t => edgeType.includes(t));

      const baseColor = isConnectedToSelected
        ? "#F97316"
        : isSupportive
          ? "#22C55E"
          : isContradictory
            ? "#EF4444"
            : "#94A3B8";

      return {
        id: `${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        label: edge.type || edge.relationship_type,
        animated: isConnectedToSelected,
        style: {
          stroke: baseColor,
          strokeWidth: isConnectedToSelected ? 3 : 2,
          opacity: isConnectedToSelected ? 1 : 0.8,
          transition: "all 0.3s ease-in-out",
        },
        labelStyle: {
          fontSize: "10px",
          fontWeight: "600",
          fill: baseColor,
        },
        markerEnd: {
          type: "arrowclosed",
          width: 15,
          height: 15,
          color: baseColor,
        },
      };
    });

    // Add nodes & edges to Dagre graph for auto-layout
    nodes.forEach((node) =>
      dagreGraph.setNode(node.id, { width: 350, height: 200 })
    );
    edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

    dagre.layout(dagreGraph); // Apply layout

    // FIXED: Update positions from Dagre with defensive fallback
    const positionedNodes = nodes.map((node, index) => {
      const dagreNode = dagreGraph.node(node.id);
      // Defensive: if dagre didn't compute position, use grid fallback
      const position = dagreNode
        ? { x: dagreNode.x, y: dagreNode.y }
        : { x: (index % 3) * 450, y: Math.floor(index / 3) * 280 };

      if (!dagreNode) {
        console.warn(`[ThematicView] Dagre missing position for node ${node.id}, using fallback`);
      }

      return {
        ...node,
        position,
      };
    });

    // Debug logging before returning
    console.log("[ThematicView] Created", positionedNodes.length, "nodes with IDs:", positionedNodes.map(n => n.id));
    console.log("[ThematicView] Created", edges.length, "edges for ReactFlow");
    if (edges.length > 0) {
      console.log("[ThematicView] First edge:", edges[0]);
      console.log("[ThematicView] All edges:", edges.map(e => `${e.source} -> ${e.target} (${e.label})`));
    }

    // DIAGNOSTIC: Verify edge source/target match node IDs
    const nodeIds = new Set(positionedNodes.map(n => n.id));
    const invalidEdges = edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
    if (invalidEdges.length > 0) {
      console.error("[ThematicView] DIAGNOSTIC - INVALID EDGES (source/target not in nodes):", invalidEdges);
      console.error("[ThematicView] DIAGNOSTIC - Available node IDs:", [...nodeIds]);
    } else if (edges.length > 0) {
      console.log("[ThematicView] DIAGNOSTIC - All edges valid (source/target match node IDs)");
    }

    return { nodes: positionedNodes, edges };
  }, [activeData, currentLevel, selectedThematicNode, hoveredNode, highlightedUtterances, isNodeHighlightedByUtterance, fontSize, fontSizeClasses]);

  // Get selected node and its utterances
  const selectedNodeData = useMemo(() => {
    if (!selectedThematicNode || !activeData?.thematic_nodes) return null;
    return activeData.thematic_nodes.find(n => n.id === selectedThematicNode);
  }, [selectedThematicNode, activeData]);

  const selectedNodeUtterances = useMemo(() => {
    if (!selectedNodeData?.utterance_ids || !utterances.length) return [];
    const uttMap = new Map(utterances.map(u => [u.id, u]));
    return selectedNodeData.utterance_ids
      .map(id => uttMap.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.timestamp_start || 0) - (b.timestamp_start || 0));
  }, [selectedNodeData, utterances]);

  return { nodes, edges, selectedNodeData, selectedNodeUtterances };
}
