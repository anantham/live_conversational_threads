import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { useReactFlow, ReactFlowProvider } from "reactflow";
import dagre from "dagre";
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

function extractContextualRelationEntries(contextualRelation) {
  if (!contextualRelation || typeof contextualRelation !== "object" || Array.isArray(contextualRelation)) {
    return [];
  }

  const relatedNode =
    contextualRelation.related_node_name ||
    contextualRelation.related_node ||
    contextualRelation.relatedNode ||
    contextualRelation.source ||
    contextualRelation.from ||
    contextualRelation.node;
  const relationText =
    contextualRelation.relation_text ||
    contextualRelation.relationText ||
    contextualRelation.description ||
    contextualRelation.explanation;
  const singleRelationKeys = new Set([
    "related_node_name",
    "related_node",
    "relatedNode",
    "source",
    "from",
    "node",
    "relation_text",
    "relationText",
    "description",
    "explanation",
    "relation_type",
    "type",
  ]);
  const keys = Object.keys(contextualRelation);
  const looksLikeSingleRelation =
    Boolean(relatedNode && relationText) && keys.every((key) => singleRelationKeys.has(key));

  if (looksLikeSingleRelation) {
    return [[String(relatedNode), String(relationText)]];
  }

  return Object.entries(contextualRelation)
    .filter(([name, text]) => Boolean(String(name).trim()) && Boolean(String(text).trim()))
    .map(([name, text]) => [String(name), String(text)]);
}

function layoutWithDagre(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => g.setNode(n.id, { width: 120, height: 40 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => ({
    ...n,
    position: g.node(n.id) || { x: 0, y: 0 },
  }));
}

function MinimalGraphInner({
  graphData,
  selectedNode,
  setSelectedNode,
}) {
  const reactFlow = useReactFlow();
  const autoFollowRef = useRef(true);
  const latestChunk = useMemo(
    () => graphData?.[graphData.length - 1] || [],
    [graphData]
  );

  const normalizedChunk = useMemo(
    () => latestChunk.map((item, index) => normalizeGraphNode(item, index)).filter(Boolean),
    [latestChunk]
  );

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(normalizedChunk), [normalizedChunk]);

  // Build ReactFlow nodes
  const rfNodes = useMemo(() => {
    return normalizedChunk.map((item) => {
      const isSelected = selectedNode === item.id;
      const speakerColor = speakerColorMap[item.speaker_id] || "#e2e8f0";
      const label =
        item.node_name && item.node_name.length > 30
          ? item.node_name.slice(0, 28) + "\u2026"
          : item.node_name || "";

      return {
        id: item.id,
        data: { label, fullData: item },
        position: { x: 0, y: 0 },
        style: {
          background: speakerColor,
          border: isSelected ? "2px solid #f59e0b" : "1px solid #cbd5e1",
          boxShadow: isSelected
            ? "0 0 0 3px rgba(245,158,11,0.3)"
            : "none",
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
    });
  }, [normalizedChunk, selectedNode, speakerColorMap]);

  // Build ReactFlow edges
  const rfEdges = useMemo(() => {
    const edges = [];

    normalizedChunk.forEach((item) => {
      // Temporal edges
      if (item.successor) {
        const target = normalizedChunk.find((n) => n.id === item.successor);
        if (target) {
          edges.push({
            id: `t-${item.id}-${target.id}`,
            source: item.id,
            target: target.id,
            type: "smoothstep",
            style: { stroke: EDGE_COLORS.temporal_next, strokeWidth: 1, opacity: 0.4 },
            markerEnd: { type: "arrowclosed", width: 6, height: 6, color: EDGE_COLORS.temporal_next },
          });
        }
      }

      // Contextual edges from edge_relations
      const relations = Array.isArray(item.edge_relations) ? item.edge_relations : [];
      relations.forEach((rel, i) => {
        const related = normalizedChunk.find((n) => n.node_name === rel?.related_node);
        if (!related) return;
        const relType = rel.relation_type || "contextual";
        const color = EDGE_COLORS[relType] || EDGE_COLORS.contextual;
        const isConnectedToSelected = selectedNode === item.id || selectedNode === related.id;

        edges.push({
          id: `c-${related.id}-${item.id}-${i}`,
          source: related.id,
          target: item.id,
          animated: relType !== "supports" && relType !== "temporal_next",
          data: { relationType: relType, relationText: rel.relation_text || "" },
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

      // Fallback: contextual_relation map/object (backward compat)
      if (relations.length === 0 && item.contextual_relation) {
        extractContextualRelationEntries(item.contextual_relation).forEach(([relName, relText]) => {
          const related = normalizedChunk.find((n) => n.node_name === relName);
          if (!related) return;
          const color = EDGE_COLORS.contextual;
          edges.push({
            id: `c-${related.id}-${item.id}`,
            source: related.id,
            target: item.id,
            animated: true,
            data: { relationType: "contextual", relationText: String(relText) },
            style: { stroke: color, strokeWidth: 1.5, opacity: 0.5 },
            markerEnd: { type: "arrowclosed", width: 8, height: 8, color },
          });
        });
      }
    });

    return edges;
  }, [normalizedChunk, selectedNode]);

  // Layout
  const layoutedNodes = useMemo(
    () => layoutWithDagre(rfNodes, rfEdges),
    [rfNodes, rfEdges]
  );

  const selectedLayoutNode = useMemo(
    () => layoutedNodes.find((node) => node.id === selectedNode) || null,
    [layoutedNodes, selectedNode]
  );

  useEffect(() => {
    autoFollowRef.current = !selectedNode;
  }, [selectedNode]);

  // Auto-pan to latest nodes
  const lastNodeId = layoutedNodes[layoutedNodes.length - 1]?.id ?? null;
  useEffect(() => {
    if (!autoFollowRef.current || selectedNode || layoutedNodes.length === 0) return;
    const last = layoutedNodes[layoutedNodes.length - 1];
    if (last?.position) {
      reactFlow.setCenter(last.position.x, last.position.y, {
        zoom: 1,
        duration: 400,
      });
    }
  }, [lastNodeId, layoutedNodes, reactFlow, selectedNode]);

  // Center selected node when chosen from timeline or graph.
  useEffect(() => {
    if (!selectedLayoutNode?.position) return;
    reactFlow.setCenter(selectedLayoutNode.position.x, selectedLayoutNode.position.y, {
      zoom: 1.15,
      duration: 280,
    });
  }, [reactFlow, selectedLayoutNode]);

  const handleNodeClick = useCallback(
    (_, node) => {
      setSelectedNode((prev) => {
        const next = prev === node.id ? null : node.id;
        autoFollowRef.current = next === null;
        return next;
      });
    },
    [setSelectedNode]
  );

  const handlePaneClick = useCallback(() => {
    autoFollowRef.current = true;
    setSelectedNode(null);
  }, [setSelectedNode]);

  // Edge hover tooltip
  const [hoveredEdge, setHoveredEdge] = useState(null);

  const ZOOM_PRESETS = [
    { label: "Fit", action: () => reactFlow.fitView({ padding: 0.15, duration: 300 }) },
    { label: "50%", action: () => reactFlow.zoomTo(0.5, { duration: 250 }) },
    { label: "100%", action: () => reactFlow.zoomTo(1, { duration: 250 }) },
    { label: "150%", action: () => reactFlow.zoomTo(1.5, { duration: 250 }) },
  ];

  return (
    <div className="relative w-full h-full">
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
        zoomOnScroll={false}
        panOnDrag
        panOnScroll
        minZoom={0.3}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      />

      {/* Zoom preset controls */}
      <div className="absolute bottom-4 left-4 z-20 flex items-center gap-1">
        {ZOOM_PRESETS.map(({ label, action }) => (
          <button
            key={label}
            onClick={action}
            className="px-2 py-1 text-[10px] font-medium bg-white/90 border border-gray-200 rounded shadow-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            {label}
          </button>
        ))}
        <span className="ml-1 text-[9px] text-gray-400 select-none">scroll = pan · pinch = zoom</span>
      </div>

      {/* Edge hover tooltip */}
      {hoveredEdge && (
        <div className="absolute top-4 right-4 z-30 max-w-xs rounded-md bg-white/90 backdrop-blur px-3 py-2 text-xs text-gray-700 shadow-sm border border-gray-200">
          <span className="font-medium">{hoveredEdge.relationType}</span>
          {hoveredEdge.relationText && (
            <p className="mt-0.5 text-gray-500">{hoveredEdge.relationText}</p>
          )}
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
