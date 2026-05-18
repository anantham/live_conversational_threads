/* eslint-disable react-hooks/rules-of-hooks */
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { useReactFlow, ReactFlowProvider, applyNodeChanges } from "reactflow";
import "reactflow/dist/style.css";
import { EDGE_COLORS, buildSpeakerColorMap, buildTemporalColorMap } from "./graphConstants";
import {
  ZOOM_LEVEL_1,
  ZOOM_LEVEL_2,
  ZOOM_LEVEL_3,
  buildMultiScaleClusters,
} from "./graphClustering";
import { layoutByThread, layoutWithDagre } from "./graphLayout";
import {
  extractContextualRelationEntries,
  getAuthoredSemanticLevel,
  normalizeGraphNode,
  resolveRequestedSemanticLevel,
} from "./graphNormalization";
import { saveConversationDraft } from "../services/apiClient";
import ConversationNode from "./graph/ConversationNode";
import {
  COLOR_MODES,
  DEFAULT_COLOR_MODE,
  buildSpeakerColorMapForNodes,
  buildTemporalColorMapForNodes,
  resolveNodeColors,
} from "./graph/colorModes";
import ColorModeToggle from "./graph/ColorModeToggle";

// ADR-030 §D4: custom node renderer with three color modes + state markers.
// Cluster nodes are still default ReactFlow rendering (separate concern).
const NODE_TYPES = { conversational: ConversationNode };
const EDGE_TYPES = {};
// ADR-030 §D2: canonical hierarchy is up to five tiers. Level 5 (arc) is
// optional — only unlocked when the conversation earns it via the
// emergent-depth cascade. AUTHORED_LEVELS lists every possible tier;
// MinimalGraph renders only the ones present in the data.
const AUTHORED_LEVELS = [
  { level: 1, label: "chunks", type: "chunk", color: "text-teal-700", chip: "bg-teal-50", border: "border-teal-400" },
  { level: 2, label: "ideas", type: "idea", color: "text-blue-700", chip: "bg-blue-50", border: "border-blue-400" },
  { level: 3, label: "topics", type: "topic", color: "text-indigo-700", chip: "bg-indigo-50", border: "border-indigo-400" },
  { level: 4, label: "themes", type: "theme", color: "text-purple-700", chip: "bg-purple-50", border: "border-purple-400" },
  { level: 5, label: "arcs", type: "arc", color: "text-slate-700", chip: "bg-slate-100", border: "border-slate-400" },
];


function MinimalGraphInner({
  graphData,
  selectedNode,
  setSelectedNode,
  viewportReservationKey,
  onVisibleLevelChange,
  conversationId,
  initialColorMode,
}) {
  const reactFlow = useReactFlow();
  const autoFollowRef = useRef(true);
  const programmaticMoveRef = useRef(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [hideEdges, setHideEdges] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [lockedLevel, setLockedLevel] = useState(null); // null = unlocked, semantic 1-4 or legacy 0-3
  const initialLockedAppliedRef = useRef(false);
  // ADR-030 §D4: color mode (tier | speaker | temporal). Default: tier.
  // Persisted per conversation via saveConversationDraft when conversationId is provided.
  const [colorMode, setColorMode] = useState(
    COLOR_MODES.includes(initialColorMode) ? initialColorMode : DEFAULT_COLOR_MODE
  );
  const handleColorModeChange = useCallback(
    (next) => {
      setColorMode(next);
      if (conversationId) {
        saveConversationDraft(conversationId, { active_color_mode: next }).catch(
          (err) => console.warn("[MinimalGraph] color-mode persist failed:", err)
        );
      }
    },
    [conversationId]
  );

  const legacyClusterLevel = lockedLevel != null ? lockedLevel
    : zoomLevel < ZOOM_LEVEL_3 ? 3
    : zoomLevel < ZOOM_LEVEL_2 ? 2
    : zoomLevel < ZOOM_LEVEL_1 ? 1
    : 0;
  const allNodes = useMemo(
    () => (graphData || []).flat(),
    [graphData]
  );

  const normalizedChunk = useMemo(
    () => allNodes.map((item, index) => normalizeGraphNode(item, index)).filter(Boolean),
    [allNodes]
  );

  // A6: pick a default tab that surfaces a digestible top-down view.
  // Pick the TOPMOST tier where avg_children_per_parent >= 2.5 — i.e. the
  // highest level of compression that's actually compressing. For Q.m4a-with-
  // consolidation: arcs (5 nodes, ~3 themes each) wins. For a thin 3-min
  // import: ideas wins. Skips degenerate tiers (1.07x "themes" pretending
  // to compress).
  useEffect(() => {
    if (initialLockedAppliedRef.current) return;
    if (!normalizedChunk || normalizedChunk.length === 0) return;
    const byLevel = new Map();
    normalizedChunk.forEach((n) => {
      const level = Number(n.semantic_level);
      if (!Number.isFinite(level) || level < 1 || level > 5) return;
      byLevel.set(level, (byLevel.get(level) || 0) + 1);
    });
    if (byLevel.size === 0) return;
    // Walk top-down (arcs → chunks) looking for a tier with real compression
    // vs its next-finer tier. Default to the topmost tier with count >= 2.
    let chosen = null;
    for (let lvl = 5; lvl >= 1; lvl--) {
      const cur = byLevel.get(lvl) || 0;
      if (cur < 2) continue;
      const next = byLevel.get(lvl - 1) || 0;
      // Only pick a tier if it's the only populated tier above 1, OR if it
      // genuinely compresses (>= 2.5x reduction from finer tier).
      if (next === 0 || cur * 2.5 <= next) {
        chosen = lvl;
        break;
      }
    }
    if (chosen) {
      setLockedLevel(chosen);
    }
    initialLockedAppliedRef.current = true;
  }, [normalizedChunk]);

  // ADR-030 §D4: build all three color maps; the active mode picks among them.
  // No more auto-switching based on speaker count — user controls via toggle.
  const speakerColorMap = useMemo(
    () => buildSpeakerColorMapForNodes(normalizedChunk),
    [normalizedChunk]
  );
  const temporalColorMap = useMemo(
    () => buildTemporalColorMapForNodes(normalizedChunk),
    [normalizedChunk]
  );

  const buildRfNodesForSource = useCallback((sourceNodes) => {
    return sourceNodes.map((item) => {
      const isDraftNode = item.__graphLayer === "draft";

      // ADR-030 \u00a7D4: resolve color via the active mode. The renderer
      // (ConversationNode) reads fillColor/borderColor from data.
      const { fill, border } = resolveNodeColors({
        mode: colorMode,
        node: item,
        speakerColorMap,
        temporalColorMap,
      });

      // Title: node_name truncated to ~40 chars
      const title =
        item.node_name && item.node_name.length > 40
          ? item.node_name.slice(0, 38) + "\u2026"
          : item.node_name || "";

      // Summary: passed through; ConversationNode handles truncation.
      const summary = item.summary || item.full_text || "";

      // Speaker badge (prefer renamed display name over raw id)
      const speaker = item.speaker_display || item.speaker_id || "";
      const speakerLabel = isDraftNode
        ? (speaker ? `${speaker} · provisional` : "provisional")
        : speaker;

      // Authored state markers per ADR-030 §D4. Frontend renders only what
      // the backend authored; never invents these flags.
      const isTangent = Boolean(item.is_tangent);
      const isCrux = Boolean(item.is_crux);
      const isBookmark = Boolean(item.is_bookmark);
      const isContextualProgress = Boolean(item.is_contextual_progress);

      return {
        id: item.id,
        type: "conversational",
        position: { x: 0, y: 0 },
        data: {
          title,
          summary,
          speakerLabel,
          fillColor: fill,
          borderColor: border,
          isDraft: isDraftNode,
          isTangent,
          isCrux,
          isBookmark,
          isContextualProgress,
          // fullData kept for downstream consumers (NodeDetail panel etc.)
          fullData: item,
        },
      };
    });
  }, [colorMode, speakerColorMap, temporalColorMap]);

  const buildRfEdgesForSource = useCallback((sourceNodes) => {
    if (hideEdges) return [];

    const edges = [];
    const seenEdgeKeys = new Set();
    const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));

    sourceNodes.forEach((item) => {
      // Temporal edges
      if (item.successor) {
        const target = nodeById.get(item.successor);
        if (target) {
          edges.push({
            id: `t-${item.id}-${target.id}`,
            source: item.id,
            target: target.id,
            type: "smoothstep",
            style: { stroke: EDGE_COLORS.temporal_next, strokeWidth: 1, opacity: 0.4 },
            markerEnd: { type: "arrowclosed", width: 6, height: 6, color: EDGE_COLORS.temporal_next },
            data: {
              relationType: "temporal_next",
              relationText: "",
              sourceLabel: item.node_name,
              targetLabel: target.node_name,
            },
          });
        }
      }

      // Contextual edges from edge_relations
      const relations = Array.isArray(item.edge_relations) ? item.edge_relations : [];
      relations.forEach((rel) => {
        const targetName = (rel?.related_node || "").trim();
        if (!targetName) return;
        // Fuzzy match: exact → case-insensitive → substring containment
        const targetLower = targetName.toLowerCase();
        const related = sourceNodes.find((n) => n.node_name === targetName)
          || sourceNodes.find((n) => (n.node_name || "").toLowerCase() === targetLower)
          || sourceNodes.find((n) => {
            const name = (n.node_name || "").toLowerCase();
            return name.length > 5 && (name.includes(targetLower) || targetLower.includes(name));
          });
        if (!related) return;
        const relType = rel.relation_type || "contextual";
        const color = EDGE_COLORS[relType] || EDGE_COLORS.contextual;
        const isConnectedToSelected = selectedNode === item.id || selectedNode === related.id;

        const edgeLabel = relType && relType !== "contextual"
          ? relType.replace(/_/g, " ")
          : "";

        // Deduplicate bidirectional edges: normalize key as sorted pair
        const pairKey = [item.id, related.id].sort().join("--");
        const edgeId = `c-${pairKey}-${relType}`;
        if (seenEdgeKeys.has(edgeId)) return;
        seenEdgeKeys.add(edgeId);
        edges.push({
          id: edgeId,
          source: related.id,
          target: item.id,
          animated: !reduceMotion && relType !== "supports" && relType !== "temporal_next",
          label: edgeLabel || undefined,
          labelStyle: { fontSize: 9, fill: "#64748b", fontFamily: "Inter, sans-serif" },
          labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
          labelBgPadding: [4, 2],
          data: {
            relationType: relType,
            relationText: rel.relation_text || "",
            sourceLabel: related.node_name,
            targetLabel: item.node_name,
          },
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
          const relNameLower = (relName || "").toLowerCase();
          const related = sourceNodes.find((n) => n.node_name === relName)
            || sourceNodes.find((n) => (n.node_name || "").toLowerCase() === relNameLower)
            || sourceNodes.find((n) => {
              const name = (n.node_name || "").toLowerCase();
              return name.length > 5 && (name.includes(relNameLower) || relNameLower.includes(name));
            });
          if (!related) return;
          const fallbackPairKey = [item.id, related.id].sort().join("--");
          const fallbackEdgeId = `c-${fallbackPairKey}-contextual`;
          if (seenEdgeKeys.has(fallbackEdgeId)) return;
          seenEdgeKeys.add(fallbackEdgeId);
          const color = EDGE_COLORS.contextual;
          edges.push({
            id: fallbackEdgeId,
            source: related.id,
            target: item.id,
            animated: !reduceMotion,
            label: "contextual",
            labelStyle: { fontSize: 9, fill: "#64748b", fontFamily: "Inter, sans-serif" },
            labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
            labelBgPadding: [4, 2],
            data: {
              relationType: "contextual",
              relationText: String(relText),
              sourceLabel: related.node_name,
              targetLabel: item.node_name,
            },
            style: { stroke: color, strokeWidth: 1.5, opacity: 0.5 },
            markerEnd: { type: "arrowclosed", width: 8, height: 8, color },
          });
        });
      }
    });

    return edges;
  }, [selectedNode, reduceMotion, hideEdges]);

  // Build ReactFlow nodes — card-style with title + summary
  const rfNodes = useMemo(
    () => buildRfNodesForSource(normalizedChunk),
    [buildRfNodesForSource, normalizedChunk]
  );

  // Build ReactFlow edges
  const rfEdges = useMemo(
    () => buildRfEdgesForSource(normalizedChunk),
    [buildRfEdgesForSource, normalizedChunk]
  );

  const authoredSemanticLevels = useMemo(() => {
    const levels = new Set();
    normalizedChunk.forEach((node) => {
      const level = getAuthoredSemanticLevel(node);
      if (level != null) levels.add(level);
    });
    return [...levels].sort((a, b) => a - b);
  }, [normalizedChunk]);
  const hasAuthoredHierarchy = authoredSemanticLevels.length > 0;

  const authoredViews = useMemo(() => {
    if (!hasAuthoredHierarchy) return {};

    return AUTHORED_LEVELS.reduce((acc, spec) => {
      const levelNodes = normalizedChunk.filter((node) => getAuthoredSemanticLevel(node) === spec.level);
      if (levelNodes.length === 0) {
        acc[spec.level] = null;
        return acc;
      }
      const rfLevelNodes = buildRfNodesForSource(levelNodes);
      const rfLevelEdges = buildRfEdgesForSource(levelNodes);
      acc[spec.level] = {
        level: spec.level,
        label: spec.label,
        type: spec.type,
        nodes: levelNodes.length > 1
          ? layoutByThread(
              rfLevelNodes,
              rfLevelEdges,
              { nodeWidth: spec.level >= 3 ? 280 : 250, nodeHeight: spec.level >= 3 ? 102 : 90 }
            )
          : rfLevelNodes,
        edges: rfLevelEdges,
      };
      return acc;
    }, {});
  }, [buildRfEdgesForSource, buildRfNodesForSource, hasAuthoredHierarchy, normalizedChunk]);

  // Multi-scale clustering (recomputes when graph changes)
  const { l1, l2, l3 } = useMemo(
    () => buildMultiScaleClusters(normalizedChunk, speakerColorMap),
    [normalizedChunk, speakerColorMap]
  );

  // Layout each cluster level
  const layoutedL1 = useMemo(
    () => l1.clusterNodes.length > 1
      ? layoutWithDagre(l1.clusterNodes, l1.clusterEdges, { nodeWidth: 260, nodeHeight: 90 })
      : [],
    [l1]
  );
  const layoutedL2 = useMemo(
    () => l2.clusterNodes.length > 1
      ? layoutWithDagre(l2.clusterNodes, l2.clusterEdges, { nodeWidth: 280, nodeHeight: 100 })
      : [],
    [l2]
  );
  const layoutedL3 = useMemo(
    () => l3.clusterNodes.length > 1
      ? layoutWithDagre(l3.clusterNodes, l3.clusterEdges, { nodeWidth: 300, nodeHeight: 110 })
      : [],
    [l3]
  );

  // Layout for individual nodes (always computed)
  const layoutedNodes = useMemo(
    () => layoutWithDagre(rfNodes, rfEdges),
    [rfNodes, rfEdges]
  );

  // Select which level to display based on zoom.
  // Each level cascades to the next-finer level if it produces < 2 useful clusters.
  const clusterViews = useMemo(
    () => [
      null, // level 0 = individual
      layoutedL1.length > 1 ? { nodes: layoutedL1, edges: l1.clusterEdges, label: "sentences" } : null,
      layoutedL2.length > 1 ? { nodes: layoutedL2, edges: l2.clusterEdges, label: "topics" } : null,
      layoutedL3.length > 1 ? { nodes: layoutedL3, edges: l3.clusterEdges, label: "themes" } : null,
    ],
    [l1.clusterEdges, l2.clusterEdges, l3.clusterEdges, layoutedL1, layoutedL2, layoutedL3]
  );

  // At the requested level, try that level first, then cascade down
  let activeCluster = null;
  let effectiveClusterLevel = 0;
  for (let tryLevel = legacyClusterLevel; tryLevel >= 1; tryLevel--) {
    if (clusterViews[tryLevel]) {
      activeCluster = clusterViews[tryLevel];
      effectiveClusterLevel = tryLevel;
      break;
    }
  }

  const requestedSemanticLevel = lockedLevel != null ? Math.max(1, Math.min(4, lockedLevel)) : resolveRequestedSemanticLevel(zoomLevel);
  let activeSemanticView = null;
  let effectiveSemanticLevel = requestedSemanticLevel;
  if (hasAuthoredHierarchy) {
    for (let tryLevel = requestedSemanticLevel; tryLevel >= 1; tryLevel -= 1) {
      if (authoredViews[tryLevel]?.nodes?.length) {
        activeSemanticView = authoredViews[tryLevel];
        effectiveSemanticLevel = tryLevel;
        break;
      }
    }
  }

  const displayMode = activeSemanticView ? "semantic" : "legacy";
  const layoutedDisplayNodes = activeSemanticView?.nodes || activeCluster?.nodes || layoutedNodes;
  const displayEdges = activeSemanticView?.edges || activeCluster?.edges || rfEdges;
  const clusterLevelLabel = activeSemanticView?.label || activeCluster?.label || null;

  useEffect(() => {
    if (!onVisibleLevelChange) return;
    if (displayMode === "semantic") {
      onVisibleLevelChange({
        mode: "semantic",
        level: effectiveSemanticLevel,
        label: activeSemanticView?.label || null,
      });
      return;
    }
    onVisibleLevelChange({
      mode: "legacy",
      level: effectiveClusterLevel,
      label: activeCluster?.label || null,
    });
  }, [
    activeCluster,
    activeSemanticView,
    displayMode,
    effectiveClusterLevel,
    effectiveSemanticLevel,
    onVisibleLevelChange,
  ]);

  // Controlled node state — layout provides initial positions, drags persist
  const [interactiveNodes, setInteractiveNodes] = useState([]);
  const layoutKeyRef = useRef("");

  const pendingFitViewRef = useRef(false);

  useEffect(() => {
    // Generate a key from node IDs to detect when the node set changes
    const key = layoutedDisplayNodes.map((n) => n.id).join(",");
    if (key !== layoutKeyRef.current) {
      layoutKeyRef.current = key;
      setInteractiveNodes(layoutedDisplayNodes.map((n) => ({ ...n, draggable: true })));
      pendingFitViewRef.current = true;
      return;
    }
    // Same node set — merge fresh `data` and `type` into existing nodes so
    // updates that don't change node identity (e.g. color-mode toggle, draft
    // → stable transitions, authored-flag updates) take effect without
    // discarding the user's drag-positioned coordinates. ADR-030 §D4.
    const layoutNodeMap = new Map(layoutedDisplayNodes.map((n) => [n.id, n]));
    setInteractiveNodes((prev) =>
      prev.map((node) => {
        const next = layoutNodeMap.get(node.id);
        if (!next) return node;
        return {
          ...node,
          type: next.type ?? node.type,
          data: next.data,
        };
      })
    );
  }, [layoutedDisplayNodes]);

  const onNodesChange = useCallback((changes) => {
    setInteractiveNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const displayNodes = interactiveNodes.length > 0 ? interactiveNodes : layoutedDisplayNodes;

  // Run fitView after React has committed the new nodes to DOM and ReactFlow
  // has measured their positions. A single rAF isn't enough — ReactFlow's
  // nodeInternals lags one render cycle on tab switches, so fitView with
  // no caps produces nonsense viewport (e.g. scale=1 + huge negative y).
  // Two rAFs + explicit minZoom/maxZoom caps fix tab-switch auto-fit.
  //
  // Mobile (<640px viewport): the swim-lane layout produces 6 themes
  // across ~1680px. fitView with minZoom=0.04 squishes them all into
  // 360px at ~0.21 zoom — unreadable. Clamp minZoom higher on narrow
  // viewports so cards stay legible; the user pans to see more rather
  // than zooming out to nothing.
  useEffect(() => {
    if (!pendingFitViewRef.current || displayNodes.length === 0) return;
    pendingFitViewRef.current = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        programmaticMoveRef.current = true;
        const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
        if (isNarrow) {
          // On mobile, fitView would either squish the whole 1680px
          // swim-lane to 0.21 zoom (unreadable) or, with minZoom
          // clamped, center the bbox so the first rows end up above
          // the viewport top. Instead, anchor top-left of the node
          // bbox at the top-left of the viewport at a readable zoom
          // — same logic as the "Center" preset button. User pans to
          // see the rest.
          let minX = Infinity, minY = Infinity;
          displayNodes.forEach((n) => {
            const px = n.position?.x ?? 0;
            const py = n.position?.y ?? 0;
            if (px < minX) minX = px;
            if (py < minY) minY = py;
          });
          if (Number.isFinite(minX) && Number.isFinite(minY)) {
            const zoom = 0.85;
            const padding = 24;
            reactFlow.setViewport(
              { x: -minX * zoom + padding, y: -minY * zoom + padding, zoom },
              { duration: 300 },
            );
          } else {
            reactFlow.fitView({ padding: 0.1, duration: 300, minZoom: 0.6, maxZoom: 1.0 });
          }
        } else {
          reactFlow.fitView({
            padding: 0.2,
            duration: 300,
            minZoom: 0.04,
            maxZoom: 1.0,
          });
        }
        setTimeout(() => { programmaticMoveRef.current = false; }, 350);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [displayNodes, reactFlow]);

  const selectedLayoutNode = useMemo(
    () => layoutedDisplayNodes.find((node) => node.id === selectedNode) || null,
    [layoutedDisplayNodes, selectedNode]
  );

  const centerViewportOnNode = useCallback(
    (nodeId, options = {}) => {
      if (!nodeId) return undefined;

      const liveNode = reactFlow.getNode(nodeId);
      const fallbackNode = layoutedNodes.find((node) => node.id === nodeId) || null;
      const targetNode = liveNode || fallbackNode;
      const targetPosition =
        targetNode?.positionAbsolute || targetNode?.position || fallbackNode?.position || null;

      if (!targetPosition) {
        return undefined;
      }

      const width = targetNode?.width ?? targetNode?.measured?.width ?? 180;
      const height = targetNode?.height ?? targetNode?.measured?.height ?? 96;

      programmaticMoveRef.current = true;
      reactFlow.setCenter(targetPosition.x + width / 2, targetPosition.y + height / 2, options);

      const timeout = window.setTimeout(() => {
        programmaticMoveRef.current = false;
      }, (options.duration ?? 0) + 50);

      return () => window.clearTimeout(timeout);
    },
    [layoutedNodes, reactFlow]
  );

  // Sync ref with state so effects read the latest value
  useEffect(() => {
    autoFollowRef.current = autoFollow && !selectedNode;
  }, [autoFollow, selectedNode]);

  // Sync zoom level from ReactFlow viewport on every move (pan, zoom, fitView)
  const handleMoveEnd = useCallback((_event, viewport) => {
    if (viewport?.zoom != null) setZoomLevel(viewport.zoom);
    if (programmaticMoveRef.current) return;
    if (autoFollowRef.current) {
      autoFollowRef.current = false;
      setAutoFollow(false);
    }
  }, []);

  // Also sync on mount — fitView doesn't fire onMoveEnd
  useEffect(() => {
    const timer = setTimeout(() => {
      const vp = reactFlow.getViewport();
      if (vp?.zoom != null && vp.zoom !== zoomLevel) {
        setZoomLevel(vp.zoom);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [reactFlow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pan to latest nodes (only when auto-follow is active)
  const lastNodeId = layoutedDisplayNodes[layoutedDisplayNodes.length - 1]?.id ?? null;
  useEffect(() => {
    if (!autoFollow || selectedNode || layoutedDisplayNodes.length === 0) return;
    const last = layoutedDisplayNodes[layoutedDisplayNodes.length - 1];
    if (!last?.id) return;

    // Temporarily mark as programmatic so onMoveEnd doesn't disable follow
    const wasProgrammatic = programmaticMoveRef.current;
    const cleanup = centerViewportOnNode(last.id, {
      zoom: 1,
      duration: 400,
    });

    return () => {
      cleanup?.();
      programmaticMoveRef.current = wasProgrammatic;
    };
  }, [autoFollow, centerViewportOnNode, lastNodeId, layoutedDisplayNodes, selectedNode]);

  // Center selected node when chosen from timeline or graph.
  useEffect(() => {
    if (!selectedNode || !selectedLayoutNode?.position) return undefined;

    let cleanup;
    const raf = requestAnimationFrame(() => {
      cleanup = centerViewportOnNode(selectedNode, {
        zoom: 1.15,
        duration: 280,
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [centerViewportOnNode, selectedLayoutNode, selectedNode, viewportReservationKey]);

  // Cluster detail panel state
  const [selectedCluster, setSelectedCluster] = useState(null);

  const handleNodeClick = useCallback(
    (_, node) => {
      const isCluster = node.data?.memberCount != null;
      if (isCluster) {
        // Toggle cluster detail panel
        setSelectedCluster((prev) =>
          prev?.id === node.id ? null : {
            id: node.id,
            label: node.data.label,
            memberCount: node.data.memberCount,
            clusterId: node.data.clusterId,
          }
        );
        setSelectedNode(null);
        setClickedEdge(null);
        return;
      }
      setSelectedCluster(null);
      setSelectedNode((prev) => {
        const next = prev === node.id ? null : node.id;
        autoFollowRef.current = next === null;
        return next;
      });
      setClickedEdge(null);
    },
    [setSelectedNode]
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedCluster(null);
    setClickedEdge(null);
  }, [setSelectedNode]);

  // Resolve cluster member details for the detail panel
  const selectedClusterMembers = useMemo(() => {
    if (!selectedCluster) return [];
    const nodeById = new Map(normalizedChunk.map((n) => [n.id, n]));
    // Find which cluster map contains this cluster
    const clusterMap = activeCluster === clusterViews[1] ? l1.clusterMap
      : activeCluster === clusterViews[2] ? l2.clusterMap
      : activeCluster === clusterViews[3] ? l3.clusterMap
      : null;
    if (!clusterMap) return [];
    const memberIds = clusterMap.get(selectedCluster.clusterId) || [];
    return memberIds.map((id) => nodeById.get(id)).filter(Boolean);
  }, [selectedCluster, normalizedChunk, activeCluster, clusterViews, l1, l2, l3]);

  // Edge hover tooltip + pinned click panel
  const [hoveredEdge, setHoveredEdge] = useState(null);
  const [clickedEdge, setClickedEdge] = useState(null);

  const handleEdgeClick = useCallback((_, edge) => {
    setClickedEdge((prev) => (prev?.id === edge.id ? null : { id: edge.id, ...edge.data }));
  }, []);

  const MIN_READABLE_ZOOM = 0.65;
  const ZOOM_PRESETS = [
    { label: "Center", action: () => {
      // Keep the user's current zoom and anchor the camera so the TOP-LEFT
      // of the node bounding box lines up with the top-left of the viewport
      // (with a small padding). fitView's previous behavior recomputed zoom
      // AND centered on the bbox centroid — on tall wrapped layouts (147
      // ideas in a swim-lane) the centroid was visually empty between
      // column groups, putting the camera in negative space.
      const nodes = displayNodes;
      if (!nodes || nodes.length === 0) {
        reactFlow.fitView({ padding: 0.3, duration: 300, minZoom: MIN_READABLE_ZOOM });
        return;
      }
      // Compute bbox from node positions + measured sizes
      let minX = Infinity, minY = Infinity;
      nodes.forEach((n) => {
        const px = n.position?.x ?? 0;
        const py = n.position?.y ?? 0;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
      });
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
        reactFlow.fitView({ padding: 0.3, duration: 300, minZoom: MIN_READABLE_ZOOM });
        return;
      }
      const currentZoom = reactFlow.getZoom?.() ?? 1;
      const PADDING_PX = 40;
      programmaticMoveRef.current = true;
      reactFlow.setViewport(
        {
          x: -minX * currentZoom + PADDING_PX,
          y: -minY * currentZoom + PADDING_PX,
          zoom: currentZoom,
        },
        { duration: 300 },
      );
      setTimeout(() => { programmaticMoveRef.current = false; }, 350);
    }},
  ];

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onEdgeClick={handleEdgeClick}
        onMoveEnd={handleMoveEnd}
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

      {/* Zoom preset + graph display controls */}
      <div className="absolute bottom-4 left-4 z-40 flex items-center gap-1">
        {ZOOM_PRESETS.map(({ label, action }) => (
          <button
            key={label}
            onClick={action}
            className="px-2 py-1 text-[10px] font-medium bg-white/90 border border-gray-200 rounded shadow-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            {label}
          </button>
        ))}
        <span className="mx-1 select-none text-[9px] text-gray-300">|</span>
        <button
          onClick={() => {
            setAutoFollow((v) => {
              const next = !v;
              autoFollowRef.current = next;
              if (next && layoutedNodes.length > 0) {
                const last = layoutedNodes[layoutedNodes.length - 1];
                if (last?.id) {
                  centerViewportOnNode(last.id, { zoom: 1, duration: 300 });
                }
              }
              return next;
            });
          }}
          title={autoFollow ? "Auto-follow is on — click to stop" : "Auto-follow is off — click to resume"}
          className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
            autoFollow
              ? "bg-blue-50 border-blue-300 text-blue-700"
              : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {autoFollow ? "Following" : "Follow"}
        </button>
        <span className="mx-1 select-none text-[9px] text-gray-300">|</span>
        <button
          onClick={() => setReduceMotion((v) => !v)}
          title={reduceMotion ? "Re-enable edge animation" : "Stop edge animation"}
          className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
            reduceMotion
              ? "bg-amber-50 border-amber-300 text-amber-700"
              : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {reduceMotion ? "Motion off" : "Motion on"}
        </button>
        <button
          onClick={() => setHideEdges((v) => !v)}
          title={hideEdges ? "Show edges" : "Hide edges"}
          className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
            hideEdges
              ? "bg-amber-50 border-amber-300 text-amber-700"
              : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {hideEdges ? "Edges off" : "Edges on"}
        </button>
        <span className="mx-1 select-none text-[9px] text-gray-300">|</span>
        <ColorModeToggle mode={colorMode} onChange={handleColorModeChange} />
      </div>

      {/* Zoom / cluster HUD — top-left */}
      <div className="absolute top-3 left-3 z-40 flex items-center gap-2 select-none">
        <div className="flex items-center gap-1.5 rounded-md bg-white/90 backdrop-blur border border-gray-200 shadow-sm px-2.5 py-1.5">
          <span className="text-[10px] font-mono text-gray-500">{Math.round(zoomLevel * 100)}%</span>
          <span className="text-[9px] text-gray-300">|</span>
          {clusterLevelLabel ? (
            <>
              <span className={`text-[10px] font-semibold ${
                displayMode === "semantic"
                  ? (AUTHORED_LEVELS.find((spec) => spec.level === effectiveSemanticLevel)?.color || "text-blue-600")
                  : effectiveClusterLevel === 3
                  ? "text-purple-600"
                  : effectiveClusterLevel === 2
                  ? "text-blue-600"
                  : "text-teal-600"
              }`}>
                {clusterLevelLabel}
              </span>
              <span className="text-[10px] text-gray-500">
                {displayMode === "semantic"
                  ? `${displayNodes.length} ${activeSemanticView?.type || "nodes"} · ${normalizedChunk.length} authored nodes`
                  : `${displayNodes.length} clusters · ${normalizedChunk.length} nodes`}
              </span>
              {lockedLevel != null && (
                <span className="text-[9px] text-amber-500 ml-1">locked</span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-gray-500">
              {normalizedChunk.length} nodes · {displayEdges.length} edges
              {lockedLevel != null && (
                <span className="text-[9px] text-amber-500 ml-1">locked</span>
              )}
            </span>
          )}
        </div>
        {/* Zoom scale — click to lock semantic or clustered level, click again to unlock */}
        <div className="flex items-center gap-0 rounded-md bg-white/90 backdrop-blur border border-gray-200 shadow-sm overflow-hidden">
          {(displayMode === "semantic"
            ? AUTHORED_LEVELS
            : [
                { label: "nodes", level: 0, chip: "bg-gray-100", border: "border-gray-400", color: "text-gray-700" },
                { label: "sentences", level: 1, chip: "bg-teal-50", border: "border-teal-400", color: "text-teal-700" },
                { label: "topics", level: 2, chip: "bg-blue-50", border: "border-blue-400", color: "text-blue-700" },
                { label: "themes", level: 3, chip: "bg-purple-50", border: "border-purple-400", color: "text-purple-700" },
              ]
          ).map(({ label, level, chip, border, color }) => {
            const isActive = displayMode === "semantic"
              ? effectiveSemanticLevel === level
              : legacyClusterLevel === level;
            const isLocked = lockedLevel === level;
            return (
              <button
                key={label}
                onClick={() => {
                  // Explicit tier selection is a camera intent — disable
                  // auto-follow so the fitView triggered by the layout change
                  // isn't overridden by the autoFollow setCenter(zoom=1).
                  autoFollowRef.current = false;
                  setAutoFollow(false);
                  if (lockedLevel === level) {
                    setLockedLevel(null); // unlock
                  } else {
                    setLockedLevel(level); // lock to this level
                  }
                }}
                title={isLocked ? `Locked to ${label} — click to unlock` : `Click to lock at ${label} level`}
                className={`px-2 py-1 text-[9px] font-medium transition-colors cursor-pointer ${
                  isActive
                    ? `${chip} ${color} border-b-2 ${border}`
                    : isLocked
                    ? `${chip} ${color} border-b-2 border-dashed ${border}`
                    : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}{isLocked ? " \u{1F512}" : ""}
              </button>
            );
          })}
        </div>
        {lockedLevel != null && (
          <button
            onClick={() => setLockedLevel(null)}
            className="text-[9px] text-gray-400 hover:text-gray-600 ml-1"
            title="Unlock zoom level"
          >
            unlock
          </button>
        )}
      </div>

      {/* Edge hover tooltip — transient, top-right */}
      {hoveredEdge && !clickedEdge && (
        <div className="absolute top-4 right-4 z-30 max-w-xs rounded-md bg-white/90 backdrop-blur px-3 py-2 text-xs text-gray-700 shadow-sm border border-gray-200 pointer-events-none">
          <span className="font-medium capitalize">{hoveredEdge.relationType}</span>
          {hoveredEdge.relationText && (
            <p className="mt-0.5 text-gray-500 line-clamp-2">{hoveredEdge.relationText}</p>
          )}
          <p className="mt-1 text-[10px] text-gray-400">click to pin</p>
        </div>
      )}

      {/* Edge click detail panel — pinned, bottom-right */}
      {clickedEdge && (
        <div className="absolute bottom-14 right-4 z-30 w-72 rounded-lg bg-white border border-gray-200 shadow-lg px-4 py-3 text-xs text-gray-700">
          <div className="flex items-start justify-between gap-2 mb-2">
            <span className="font-semibold text-gray-900 capitalize leading-tight">
              {clickedEdge.relationType?.replace(/_/g, " ")}
            </span>
            <button
              onClick={() => setClickedEdge(null)}
              className="text-gray-400 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {(clickedEdge.sourceLabel || clickedEdge.targetLabel) && (
            <p className="text-[10px] text-gray-400 mb-2 truncate">
              {clickedEdge.sourceLabel}
              <span className="mx-1">→</span>
              {clickedEdge.targetLabel}
            </p>
          )}
          {clickedEdge.relationText ? (
            <p className="leading-relaxed text-gray-600">{clickedEdge.relationText}</p>
          ) : (
            <p className="text-gray-400 italic">No relation detail available.</p>
          )}
        </div>
      )}

      {/* Cluster detail panel — shows member nodes when a cluster is clicked */}
      {selectedCluster && selectedClusterMembers.length > 0 && (
        <div className="absolute top-14 right-4 z-30 w-80 max-h-[60vh] rounded-lg bg-white border border-gray-200 shadow-lg text-xs text-gray-700 overflow-hidden flex flex-col">
          <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-gray-100 shrink-0">
            <div>
              <span className="font-semibold text-gray-900 text-sm leading-tight block">
                {selectedCluster.label}
              </span>
              <span className="text-[10px] text-gray-400 mt-0.5 block">
                {selectedClusterMembers.length} nodes in this cluster
              </span>
            </div>
            <button
              onClick={() => setSelectedCluster(null)}
              className="text-gray-400 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-2 flex-1">
            {selectedClusterMembers.map((node, i) => (
              <div
                key={node.id}
                className="py-2 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 -mx-1 px-1 rounded"
                onClick={() => {
                  // Drill down: lock to nodes level and select this node
                  setLockedLevel(0);
                  setSelectedNode(node.id);
                  setSelectedCluster(null);
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-300 font-mono w-4 shrink-0">{i + 1}</span>
                  <span className="font-medium text-gray-800 truncate">{node.node_name}</span>
                </div>
                {node.source_excerpt && (
                  <p className="text-[10px] text-gray-400 mt-0.5 ml-6 line-clamp-2">{node.source_excerpt}</p>
                )}
                {node.summary && !node.source_excerpt && (
                  <p className="text-[10px] text-gray-400 mt-0.5 ml-6 line-clamp-2">{node.summary}</p>
                )}
                <div className="flex gap-2 mt-1 ml-6">
                  {(node.speaker_display || node.speaker_id) && (
                    <span className="text-[9px] text-gray-400">speaker: {node.speaker_display || node.speaker_id}</span>
                  )}
                  {node.edge_relations?.length > 0 && (
                    <span className="text-[9px] text-gray-400">{node.edge_relations.length} edges</span>
                  )}
                  {node.thread_state && node.thread_state !== "continue_thread" && (
                    <span className="text-[9px] text-blue-400">{node.thread_state.replace(/_/g, " ")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context-sensitive color legend — adapts to current zoom level.
          Pinned bottom-LEFT (away from the SPEAKERS panel / edge-detail / cluster
          panels that all live bottom-right). The tooltip opens upward from the
          icon's LEFT edge, extending rightward into empty canvas space. */}
      {normalizedChunk.length > 0 && (
        <div className="absolute bottom-14 left-4 z-40">
          <details className="group">
            <summary className="cursor-pointer list-none p-2 bg-white/80 hover:bg-white/95 backdrop-blur rounded-full shadow-sm border border-gray-200 text-gray-400 hover:text-gray-600 transition opacity-60 hover:opacity-100">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            </summary>
            <div className="absolute bottom-full left-0 mb-2 bg-white/95 backdrop-blur rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-2 min-w-[180px] animate-slideIn">
              {displayMode === "semantic" ? (
                <>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Current semantic level</span>
                    <div className="mt-1 text-[11px] text-gray-600">
                      {AUTHORED_LEVELS.find((spec) => spec.level === effectiveSemanticLevel)?.label || "authored"}
                    </div>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      This view is using backend-authored hierarchy, not frontend clustering.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Node color = Speaker / temporal palette</span>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      Speaker colors appear when multiple speakers are detected. Otherwise colors fade by temporal position.
                    </div>
                  </div>
                </>
              ) : effectiveClusterLevel === 0 ? (
                <>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Node color = Speaker</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(speakerColorMap).slice(0, 5).map(([sid, color]) => (
                        <div key={sid} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full border border-gray-300" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{sid}</span>
                        </div>
                      ))}
                      {Object.keys(speakerColorMap).length === 0 && (
                        <span className="text-gray-400 italic">No speakers detected</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Edge color = Relation</span>
                    <div className="mt-1 space-y-1">
                      {[
                        { label: "supports", color: EDGE_COLORS.supports },
                        { label: "rebuts", color: EDGE_COLORS.rebuts },
                        { label: "clarifies", color: EDGE_COLORS.clarifies },
                        { label: "tangent", color: EDGE_COLORS.tangent },
                        { label: "temporal", color: EDGE_COLORS.temporal_next },
                      ].map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Node color = Wavelength Rainbow</span>
                    <div className="mt-2 flex flex-col gap-1">
                      <div 
                        className="h-2 w-full rounded-full" 
                        style={{ background: 'linear-gradient(to right, hsl(0, 75%, 88%), hsl(140, 75%, 88%), hsl(280, 75%, 88%))' }}
                      />
                      <div className="flex justify-between text-[9px] text-gray-400 font-mono uppercase tracking-tight">
                        <span>Start</span>
                        <span>Now</span>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-gray-500 leading-tight">
                      Nodes stretch across the spectrum as the conversation grows. Labels update to speaker colors after ~2 mins.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">Edge color = Agreement</span>
                    <div className="mt-1 space-y-1">
                      {[
                        { label: "supports / agrees", color: EDGE_COLORS.supports },
                        { label: "rebuts / disagrees", color: EDGE_COLORS.rebuts },
                        { label: "clarifies", color: EDGE_COLORS.clarifies },
                        { label: "temporal flow", color: EDGE_COLORS.temporal_next },
                      ].map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-400">
                    Edge thickness = number of connections between clusters
                  </div>
                </>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

MinimalGraphInner.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
  viewportReservationKey: PropTypes.string,
  onVisibleLevelChange: PropTypes.func,
  conversationId: PropTypes.string,
  initialColorMode: PropTypes.oneOf(COLOR_MODES),
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
  viewportReservationKey: PropTypes.string,
  onVisibleLevelChange: PropTypes.func,
  conversationId: PropTypes.string,
  initialColorMode: PropTypes.oneOf(COLOR_MODES),
};
