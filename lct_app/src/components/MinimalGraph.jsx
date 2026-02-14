import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import dagre from "dagre";
import ReactFlow, { ReactFlowProvider, useReactFlow } from "reactflow";

import "reactflow/dist/style.css";
import { EDGE_COLORS, buildSpeakerColorMap } from "./graphConstants";

const NODE_TYPES = {};
const EDGE_TYPES = {};

function normalizeGraphNode(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const rawId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
  const rawName =
    typeof item.node_name === "string" && item.node_name.trim() ? item.node_name.trim() : "";
  const fallbackName =
    typeof item.summary === "string" && item.summary.trim()
      ? item.summary.trim().slice(0, 48)
      : `Node ${index + 1}`;

  return {
    ...item,
    id: rawId || `node-${index}`,
    node_name: rawName || fallbackName,
    speaker_id: typeof item.speaker_id === "string" ? item.speaker_id : "",
    successor: typeof item.successor === "string" ? item.successor : "",
    edge_relations: Array.isArray(item.edge_relations) ? item.edge_relations : [],
    contextual_relation:
      item.contextual_relation &&
      typeof item.contextual_relation === "object" &&
      !Array.isArray(item.contextual_relation)
        ? item.contextual_relation
        : {},
  };
}

function layoutWithDagre(nodes, edges) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  graph.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((node) => graph.setNode(node.id, { width: 120, height: 40 }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));

  dagre.layout(graph);

  return nodes.map((node) => ({
    ...node,
    position: graph.node(node.id) || { x: 0, y: 0 },
  }));
}

function MinimalGraphInner({ graphData, selectedNode, setSelectedNode }) {
  const reactFlow = useReactFlow();
  const autoFollowRef = useRef(true);
  const [hoveredEdge, setHoveredEdge] = useState(null);

  const latestChunk = useMemo(() => graphData?.[graphData.length - 1] || [], [graphData]);

  const normalizedChunk = useMemo(
    () => latestChunk.map((item, index) => normalizeGraphNode(item, index)).filter(Boolean),
    [latestChunk]
  );

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(normalizedChunk), [normalizedChunk]);

  const rfNodes = useMemo(
    () =>
      normalizedChunk.map((item) => {
        const isSelected = selectedNode === item.id;
        const speakerColor = speakerColorMap[item.speaker_id] || "#e2e8f0";
        const label =
          item.node_name && item.node_name.length > 30
            ? `${item.node_name.slice(0, 28)}\u2026`
            : item.node_name || "";

        return {
          id: item.id,
          data: { label, fullData: item },
          position: { x: 0, y: 0 },
          style: {
            background: speakerColor,
            border: isSelected ? "2px solid #f59e0b" : "1px solid #cbd5e1",
            boxShadow: isSelected ? "0 0 0 3px rgba(245,158,11,0.3)" : "none",
            borderRadius: "9999px",
            padding: "6px 12px",
            fontSize: "11px",
            fontFamily: "Inter, sans-serif",
            fontWeight: 500,
            color: "#1e293b",
            cursor: "pointer",
            transition: "all 0.2s ease",
            whiteSpace: "nowrap",
            maxWidth: "150px",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        };
      }),
    [normalizedChunk, selectedNode, speakerColorMap]
  );

  const rfEdges = useMemo(() => {
    const edges = [];

    normalizedChunk.forEach((item) => {
      if (item.successor) {
        const target = normalizedChunk.find((node) => node.id === item.successor);
        if (target) {
          edges.push({
            id: `t-${item.id}-${target.id}`,
            source: item.id,
            target: target.id,
            type: "smoothstep",
            style: { stroke: EDGE_COLORS.temporal_next, strokeWidth: 1, opacity: 0.4 },
            markerEnd: {
              type: "arrowclosed",
              width: 6,
              height: 6,
              color: EDGE_COLORS.temporal_next,
            },
          });
        }
      }

      const relations = Array.isArray(item.edge_relations) ? item.edge_relations : [];
      relations.forEach((relation, index) => {
        const related = normalizedChunk.find((node) => node.node_name === relation?.related_node);
        if (!related) return;

        const relationType = relation.relation_type || "contextual";
        const color = EDGE_COLORS[relationType] || EDGE_COLORS.contextual;
        const isConnectedToSelected = selectedNode === item.id || selectedNode === related.id;

        edges.push({
          id: `c-${related.id}-${item.id}-${index}`,
          source: related.id,
          target: item.id,
          animated: relationType !== "supports" && relationType !== "temporal_next",
          data: { relationType, relationText: relation.relation_text || "" },
          style: {
            stroke: isConnectedToSelected ? "#f59e0b" : color,
            strokeWidth: isConnectedToSelected ? 2.5 : 1.5,
            opacity: isConnectedToSelected ? 1 : 0.6,
            transition: "all 0.2s ease",
          },
          markerEnd: {
            type: "arrowclosed",
            width: 8,
            height: 8,
            color: isConnectedToSelected ? "#f59e0b" : color,
          },
        });
      });

      if (relations.length === 0 && item.contextual_relation) {
        Object.entries(item.contextual_relation).forEach(([relationName, relationText]) => {
          const related = normalizedChunk.find((node) => node.node_name === relationName);
          if (!related) return;
          const color = EDGE_COLORS.contextual;

          edges.push({
            id: `c-${related.id}-${item.id}`,
            source: related.id,
            target: item.id,
            animated: true,
            data: { relationType: "contextual", relationText: String(relationText) },
            style: { stroke: color, strokeWidth: 1.5, opacity: 0.5 },
            markerEnd: { type: "arrowclosed", width: 8, height: 8, color },
          });
        });
      }
    });

    return edges;
  }, [normalizedChunk, selectedNode]);

  const layoutedNodes = useMemo(() => layoutWithDagre(rfNodes, rfEdges), [rfNodes, rfEdges]);

  const lastNodeId = layoutedNodes[layoutedNodes.length - 1]?.id ?? null;
  useEffect(() => {
    if (!autoFollowRef.current || layoutedNodes.length === 0) return;
    const lastNode = layoutedNodes[layoutedNodes.length - 1];
    if (!lastNode?.position) return;

    reactFlow.setCenter(lastNode.position.x, lastNode.position.y, { zoom: 1, duration: 400 });
  }, [lastNodeId, layoutedNodes, reactFlow]);

  const handleNodeClick = useCallback(
    (_, node) => {
      setSelectedNode((previous) => (previous === node.id ? null : node.id));
    },
    [setSelectedNode]
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={layoutedNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.data)}
        onEdgeMouseLeave={() => setHoveredEdge(null)}
        fitView
        zoomOnPinch
        zoomOnScroll
        panOnDrag
        panOnScroll={false}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      />

      {hoveredEdge && (
        <div className="absolute right-4 top-4 z-30 max-w-xs rounded-md border border-gray-200 bg-white/90 px-3 py-2 text-xs text-gray-700 shadow-sm backdrop-blur">
          <span className="font-medium">{hoveredEdge.relationType}</span>
          {hoveredEdge.relationText && <p className="mt-0.5 text-gray-500">{hoveredEdge.relationText}</p>}
        </div>
      )}
    </div>
  );
}

MinimalGraphInner.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
};

export default function MinimalGraph(props) {
  return (
    <ReactFlowProvider>
      <MinimalGraphInner {...props} />
    </ReactFlowProvider>
  );
}

MinimalGraph.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
};
