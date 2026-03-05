import { useMemo } from "react";
import dagre from "dagre";
import { EDGE_RELATION_STYLE, extractContextualRelationEntries } from "./contextualGraphUtils";

const SPEAKER_PALETTE = [
  "#FFB3BA", "#FFDFBA", "#FFFFBA", "#BAFFC9", "#BAE1FF",
  "#C9BAFF", "#FFBAF3", "#FFE4BA", "#E0BBE4", "#FFDAC1",
];

/**
 * Derives ReactFlow nodes, edges (with dagre layout), and speaker color map
 * from the latest graph chunk and currently selected node.
 */
export default function useContextualGraphLayout({ latestChunk, selectedNode }) {
  const speakerColors = useMemo(() => {
    const speakers = [...new Set(latestChunk.map((item) => item.speaker_id).filter(Boolean))];
    const colorMap = {};
    speakers.forEach((speaker, idx) => {
      colorMap[speaker] = SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length];
    });
    return colorMap;
  }, [latestChunk]);

  const { nodes, edges } = useMemo(() => {
    // Build dagre graph inside the memo so it is not shared across renders
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 100 });
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    const nodes = latestChunk.map((item) => {
      let background, border, boxShadow;

      const isUtteranceNode = item.is_utterance_node || item.speaker_id;

      if (item.is_contextual_progress) {
        background = "#ccffcc";
        border = "2px solid #33cc33";
        boxShadow = "0px 0px 10px rgba(51, 204, 51, 0.6)";
      } else if (item.is_bookmark) {
        background = "#cce5ff";
        border = "2px solid #3399ff";
        boxShadow = "0px 0px 10px rgba(51, 153, 255, 0.6)";
      } else if (selectedNode === item.id) {
        background = "#ffcc00";
        border = "3px solid #ff8800";
        boxShadow = "0px 0px 15px rgba(255, 136, 0, 0.8)";
      } else if (isUtteranceNode && item.speaker_id) {
        background = speakerColors[item.speaker_id] || "white";
        border = "2px solid " + (speakerColors[item.speaker_id] ? "#666" : "#ccc");
        boxShadow = "none";
      } else {
        background = "white";
        border = "1px solid #ccc";
        boxShadow = "none";
      }

      return {
        id: item.id,
        data: { label: item.node_name, speaker: item.speaker_id },
        position: { x: 0, y: 0 },
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

    const edges = [];

    latestChunk.forEach((item) => {
      // Temporal edges
      if (item.successor) {
        const successorNode = latestChunk.find((n) => n.id === item.successor);
        if (successorNode) {
          edges.push({
            id: `temporal-${item.id}-${successorNode.id}`,
            source: item.id,
            target: successorNode.id,
            animated: false,
            type: "smoothstep",
            data: { relationType: "temporal_next", relationText: "Next in conversation order" },
            style: { stroke: "#999", strokeWidth: 2, opacity: 0.5 },
            markerEnd: { type: "arrowclosed", width: 8, height: 8, color: "#999" },
          });
        }
      }

      // Preferred: explicit edge_relations payload
      const relationEntries = Array.isArray(item.edge_relations) ? item.edge_relations : [];

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
            data: { relationType, relationText, relationSource: relatedNodeName },
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

      // Backward-compat fallback: derive from contextual_relation map
      extractContextualRelationEntries(item.contextual_relation || {}).forEach(([relatedNodeName, relationText]) => {
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
            strokeWidth:
              selectedNode === item.id || isFormalismEdge ? style.width + 0.8 : style.width,
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

    // Apply dagre layout
    nodes.forEach((node) => dagreGraph.setNode(node.id, { width: 180, height: 50 }));
    edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));
    dagre.layout(dagreGraph);

    const positionedNodes = nodes.map((node) => ({
      ...node,
      position: dagreGraph.node(node.id),
    }));

    return { nodes: positionedNodes, edges };
  }, [latestChunk, selectedNode, speakerColors]);

  return { nodes, edges, speakerColors };
}
