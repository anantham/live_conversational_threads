/* eslint-disable react-hooks/rules-of-hooks */
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { useReactFlow, ReactFlowProvider, applyNodeChanges } from "reactflow";
import "reactflow/dist/style.css";
import {
  AUTHORED_LEVELS,
  EDGE_COLORS,
  EDGE_CATEGORY_STYLES,
  categorizeEdgeRelation,
} from "./graphConstants";
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
  buildArgumentStatusMapForNodes,
  buildDateColorMapForNodes,
  resolveNodeColors,
} from "./graph/colorModes";
import ColorModeToggle from "./graph/ColorModeToggle";

// ADR-030 §D4: custom node renderer with three color modes + state markers.
// Cluster nodes are still default ReactFlow rendering (separate concern).
const NODE_TYPES = { conversational: ConversationNode };
const EDGE_TYPES = {};

// Floor on auto-fit zoom — below this card text gets unreadable. The user
// can still mouse-wheel zoom out past it for a macro overview; this only
// caps the auto-fit behaviour on tier change / drilldown / center reset.
const MIN_READABLE_ZOOM = 0.65;


function MinimalGraphInner({
  graphData,
  selectedNode,
  setSelectedNode,
  viewportReservationKey,
  onVisibleLevelChange,
  onFocusChange,
  chromeless = false,
  conversationId,
  initialColorMode,
  initialShowTemporalEdges,
  argumentTraceFrom,
  setArgumentTraceFrom,
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
  // Drilldown stack: array of { level, nodeId, nodeName } breadcrumbs.
  // Empty = top-level (whatever tier the user is currently locked to).
  // Each click on a non-leaf node pushes one entry; the visible nodes
  // become the parent's children_ids at level-1.
  const [drilldownPath, setDrilldownPath] = useState([]);
  // ADR-032 Part C: temporal edges hidden by default. Toggle persists
  // per-conversation via saveConversationDraft (same channel as color
  // mode). Initial value comes from the conversation's stored preference.
  const [showTemporalEdges, setShowTemporalEdges] = useState(
    Boolean(initialShowTemporalEdges)
  );
  // ADR-032 Part B pattern 3: argument-scaffold trace mode. State is
  // lifted to the page (argumentTraceFrom + setArgumentTraceFrom props)
  // so NodeDetail can trigger trace via "↑ Trace ancestors" button.
  // Broaden toggle stays local.
  const [traceBroaden, setTraceBroaden] = useState(false);
  useEffect(() => {
    if (!argumentTraceFrom) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setArgumentTraceFrom?.(null);
        setTraceBroaden(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [argumentTraceFrom, setArgumentTraceFrom]);
  const handleShowTemporalEdgesChange = useCallback(
    (next) => {
      setShowTemporalEdges(next);
      if (conversationId) {
        saveConversationDraft(conversationId, { show_temporal_edges: next }).catch(
          (err) => console.warn("[MinimalGraph] temporal-edges persist failed:", err)
        );
      }
    },
    [conversationId]
  );
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

  // Default landing tier: the TOPMOST populated tier so the canvas opens on
  // the macro view (1-5 arcs / themes), not 100+ chunks. User can step down
  // via the tier-lock UI or by clicking into nodes. Earlier heuristic
  // demanded >=2.5x compression vs the next tier, but on conversations
  // where the LLM produces equal counts at L4 and L5 (no genuine
  // compression — 772ac0cc: 4 themes -> 4 arcs) it landed at L2, which
  // defeats the point. Pick the highest tier with content; if that tier
  // only has 1 node and a finer tier exists, drop down to the finer one.
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
    // Walk top-down. Land at the topmost tier with at least 1 node, UNLESS
    // that tier has only 1 node and a finer tier exists with more — in
    // that case prefer the finer tier so the user sees parallelism.
    let chosen = null;
    for (let lvl = 5; lvl >= 1; lvl--) {
      const cur = byLevel.get(lvl) || 0;
      if (cur < 1) continue;
      const next = byLevel.get(lvl - 1) || 0;
      if (cur === 1 && next >= 2) {
        // Solo node at the top is a degenerate macro view; drop one tier.
        chosen = lvl - 1;
        break;
      }
      chosen = lvl;
      break;
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
  // Argument-status map (Phase 1): id -> {status, sup, reb} from incoming edges.
  const argumentStatusMap = useMemo(
    () => buildArgumentStatusMapForNodes(normalizedChunk),
    [normalizedChunk]
  );
  // Date/meeting map: id -> categorical color per meeting (combined corpus).
  const dateColorMap = useMemo(
    () => buildDateColorMapForNodes(normalizedChunk),
    [normalizedChunk]
  );

  // Tap-friendly drill-down. Same fan-out as handleNodeDoubleClick, but callable
  // from a node's ⊕ control by id — so it works on touch (double-tap is eaten by
  // the browser) and is discoverable. Only non-leaf nodes above the chunk tier
  // expose the control; leaves and moments have nothing to fan out.
  const handleExpand = useCallback(
    (nodeId) => {
      const node = normalizedChunk.find((n) => n.id === nodeId);
      if (!node) return;
      const childIds = Array.isArray(node.children_ids) ? node.children_ids : [];
      const ownLevel = Number(node.semantic_level || node.level || 1);
      if (childIds.length === 0 || ownLevel <= 1) return;
      autoFollowRef.current = false;
      setDrilldownPath((prev) => [
        ...prev,
        { level: ownLevel, nodeId, nodeName: node.node_name || "(unnamed)" },
      ]);
    },
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
        argumentStatusMap,
        dateColorMap,
      });
      // Non-color cue for the argument view: the actual support/rebut counts.
      let argStatusLabel = null;
      if (colorMode === "argument") {
        const as = argumentStatusMap[item.id];
        if (as && (as.sup > 0 || as.reb > 0)) {
          argStatusLabel = `${as.status} · ${as.sup} supporting / ${as.reb} rebutting`;
        }
      }

      // Title: pass the full node_name through. titleStyle has no
      // white-space: nowrap, so multi-line names wrap naturally inside
      // the card. fullTitle is retained as the hover-tooltip in case
      // we ever bring back truncation for a denser tier.
      const fullTitle = item.node_name || "";
      const title = fullTitle;

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

      // Conversation-dimension markers (action_item / surprise / agreement /
      // disagreement). Rendered as a compact chip strip in ConversationNode —
      // NOT peer encodings (the card already uses rotation/border/corner/arrow).
      // Prefer the backend-normalized `markers` array; else derive from flags+edges.
      const dimensionMarkers = (
        Array.isArray(item.markers) && item.markers.length
          ? item.markers
          : [
              item.is_action_item && "action_item",
              item.is_surprise && "surprise",
              item.has_disagreement && "disagreement",
              item.has_agreement && "agreement",
            ].filter(Boolean)
      ).filter((m) =>
        ["action_item", "surprise", "agreement", "disagreement"].includes(m),
      );

      return {
        id: item.id,
        type: "conversational",
        position: { x: 0, y: 0 },
        data: {
          title,
          fullTitle,
          summary,
          speakerLabel,
          fillColor: fill,
          borderColor: border,
          isDraft: isDraftNode,
          isTangent,
          isCrux,
          isBookmark,
          isContextualProgress,
          dimensionMarkers,
          // Tap-to-fan-out: non-leaf nodes above the chunk tier get a ⊕ control
          // that drills into just this node's children (see handleExpand).
          canExpand:
            Array.isArray(item.children_ids) &&
            item.children_ids.length > 0 &&
            Number(item.semantic_level || item.level || 1) > 1,
          expandCount: Array.isArray(item.children_ids) ? item.children_ids.length : 0,
          onExpand: () => handleExpand(item.id),
          argStatusLabel,
          // fullData kept for downstream consumers (NodeDetail panel etc.)
          fullData: item,
        },
      };
    });
  }, [colorMode, speakerColorMap, temporalColorMap, argumentStatusMap, dateColorMap, handleExpand]);

  const buildRfEdgesForSource = useCallback((sourceNodes) => {
    if (hideEdges) return [];

    const edges = [];
    const seenEdgeKeys = new Set();
    const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));

    sourceNodes.forEach((item) => {
      // ADR-032 Part C: temporal edges are persisted in the data model
      // but hidden by default. Spatial X-position already encodes time
      // via the swim-lane layout (`timeBased: true`); rendering temporal
      // arrows on top would be visual noise. Reveal them only when the
      // per-conversation toggle is on (showTemporalEdges, default false).
      if (item.successor && showTemporalEdges) {
        const target = nodeById.get(item.successor);
        if (target) {
          const tempStyle = EDGE_CATEGORY_STYLES.temporal;
          edges.push({
            id: `t-${item.id}-${target.id}`,
            source: item.id,
            target: target.id,
            type: "smoothstep",
            style: {
              stroke: tempStyle.stroke,
              strokeWidth: tempStyle.strokeWidth,
              strokeDasharray: tempStyle.strokeDasharray,
              opacity: 0.5,
            },
            markerEnd: tempStyle.markerEnd
              ? { type: "arrowclosed", width: 6, height: 6, color: tempStyle.stroke }
              : undefined,
            data: {
              relationType: "temporal_next",
              relationText: "",
              category: "temporal",
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
        // ADR-032 Part C: categorize the free-text relation_type and
        // apply the category's style. Suppresses temporal edges here
        // (already handled by the dedicated successor block above);
        // the toggle still applies.
        const category = categorizeEdgeRelation(relType);
        if (category === "temporal" && !showTemporalEdges) return;
        const catStyle = EDGE_CATEGORY_STYLES[category] || EDGE_CATEGORY_STYLES.other;
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
          // Only "soft" relation types animate (asks/clarifies). Solid
          // logical edges (supports/rebuts/implies) stay static — they're
          // structural claims, not transient signals.
          animated: !reduceMotion && (category === "conversational-q" || category === "conversational-flow"),
          label: edgeLabel || undefined,
          labelStyle: { fontSize: 9, fill: "#64748b", fontFamily: "Inter, sans-serif" },
          labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
          labelBgPadding: [4, 2],
          data: {
            relationType: relType,
            relationText: rel.relation_text || "",
            category,
            sourceLabel: related.node_name,
            targetLabel: item.node_name,
          },
          style: {
            stroke: isConnectedToSelected ? "#f59e0b" : catStyle.stroke,
            strokeWidth: isConnectedToSelected ? 2.5 : (catStyle.strokeWidth || 1.5),
            strokeDasharray: catStyle.strokeDasharray,
            opacity: isConnectedToSelected ? 1 : 0.7,
            transition: "all 0.2s ease",
          },
          markerEnd: catStyle.markerEnd ? {
            type: "arrowclosed",
            width: 8,
            height: 8,
            color: isConnectedToSelected ? "#f59e0b" : catStyle.stroke,
          } : undefined,
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
  }, [selectedNode, reduceMotion, hideEdges, showTemporalEdges]);

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

    // ADR-032 Part A: compute pixelsPerSecond from the overall
    // conversation duration so the swim-lane fills a reasonable width.
    // Target: roughly 3000px wide for the timeline (gives the viewport
    // some room to scroll while keeping nodes readable). Falls back to
    // a fixed value if duration can't be derived.
    let pixelsPerSecond = 6;
    const tsValues = normalizedChunk
      .map((n) => Number(n.timestamp_start))
      .filter((v) => Number.isFinite(v));
    const tsEndValues = normalizedChunk
      .map((n) => Number(n.timestamp_end))
      .filter((v) => Number.isFinite(v));
    if (tsValues.length > 0 && tsEndValues.length > 0) {
      const totalDuration = Math.max(...tsEndValues) - Math.min(...tsValues);
      if (totalDuration > 0) {
        pixelsPerSecond = Math.max(2, Math.min(20, 3000 / totalDuration));
      }
    }

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
              {
                // ConversationNode caps at 360w; summary text pushes
                // heights to ~280. Layout must reserve that footprint
                // or rows overlap horizontally + vertically.
                nodeWidth: 360,
                nodeHeight: 280,
                // ADR-032 Part A: X=timestamp_start, Y=thread row.
                // Falls back to column-index automatically when too few
                // nodes have timestamps (legacy / unrecorded conversations).
                timeBased: true,
                pixelsPerSecond,
                minNodeWidth: spec.level >= 3 ? 280 : 200,
              }
            )
          : rfLevelNodes,
        edges: rfLevelEdges,
      };
      return acc;
    }, {});
  }, [buildRfEdgesForSource, buildRfNodesForSource, hasAuthoredHierarchy, normalizedChunk]);

  // ADR-032 Part B pattern 3: walk incoming edges from argumentTraceFrom.
  // Default: only logical-pos / logical-causal / logical-meta categories
  // (the strict "argument scaffolding" view). With traceBroaden, include
  // conversational and causal-style categories too. Depth-limited to 3.
  const traceResult = useMemo(() => {
    if (!argumentTraceFrom) return { nodes: null, edges: null };

    const allowedCategories = traceBroaden
      ? new Set([
          "logical-pos",
          "logical-neg",
          "logical-causal",
          "logical-meta",
          "conversational-q",
          "conversational-flow",
          "thread-flow",
          "other",
        ])
      : new Set(["logical-pos", "logical-causal", "logical-meta"]);

    // Build adjacency: incomingByTarget[target] = [{from, category, relType}, ...]
    const incomingByTarget = new Map();
    normalizedChunk.forEach((item) => {
      const rels = Array.isArray(item.edge_relations) ? item.edge_relations : [];
      rels.forEach((rel) => {
        const targetName = (rel?.related_node || "").trim();
        if (!targetName) return;
        const targetLower = targetName.toLowerCase();
        const targetNode = normalizedChunk.find((n) => n.id === targetName)
          || normalizedChunk.find((n) => n.node_name === targetName)
          || normalizedChunk.find((n) => (n.node_name || "").toLowerCase() === targetLower);
        if (!targetNode) return;
        const category = categorizeEdgeRelation(rel.relation_type || "contextual");
        // Edge stored on item points AT targetNode. For ancestor walk we
        // want incoming edges TO each node — so the source-of-edge is
        // ``item`` (which "supports" targetNode), and targetNode receives.
        const arr = incomingByTarget.get(targetNode.id) || [];
        arr.push({
          fromId: item.id,
          category,
          relType: rel.relation_type || "contextual",
        });
        incomingByTarget.set(targetNode.id, arr);
      });
    });

    const visited = new Set([argumentTraceFrom]);
    const tracedEdges = new Set();
    const queue = [{ id: argumentTraceFrom, depth: 0 }];
    const MAX_DEPTH = 3;
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (depth >= MAX_DEPTH) continue;
      const incoming = incomingByTarget.get(id) || [];
      for (const edge of incoming) {
        if (!allowedCategories.has(edge.category)) continue;
        // Edge id mirrors what buildRfEdgesForSource produced — the
        // pair-key + relType pattern.
        const pairKey = [edge.fromId, id].sort().join("--");
        tracedEdges.add(`c-${pairKey}-${edge.relType}`);
        if (!visited.has(edge.fromId)) {
          visited.add(edge.fromId);
          queue.push({ id: edge.fromId, depth: depth + 1 });
        }
      }
    }
    return { nodes: visited, edges: tracedEdges };
  }, [argumentTraceFrom, traceBroaden, normalizedChunk]);

  // Drill-down: when the user clicks an aggregate node, show only its
  // descendants at level-1. The path is a stack so nested drills are supported.
  // children_ids is normalized as an array of UUID strings on every node;
  // empty array means leaf (don't allow drilling into it).
  const drilledView = useMemo(() => {
    if (drilldownPath.length === 0) return null;
    const tail = drilldownPath[drilldownPath.length - 1];
    const parentNode = normalizedChunk.find((n) => n.id === tail.nodeId);
    if (!parentNode) return null;
    const childIds = new Set(parentNode.children_ids || []);
    if (childIds.size === 0) return null;
    const targetLevel = tail.level - 1;
    if (targetLevel < 1) return null;
    const tierSpec = AUTHORED_LEVELS.find((spec) => spec.level === targetLevel);
    const tierView = authoredViews[targetLevel];
    const baseNodes = tierView?.nodes || [];
    const filteredNodes = baseNodes.filter((rfNode) => childIds.has(rfNode.id));
    if (filteredNodes.length === 0) return null;
    const allowed = new Set(filteredNodes.map((rfNode) => rfNode.id));
    const filteredEdges = (tierView?.edges || []).filter(
      (e) => allowed.has(e.source) && allowed.has(e.target)
    );
    return {
      level: targetLevel,
      label: tierSpec?.label || `level ${targetLevel}`,
      type: tierSpec?.type || "node",
      nodes: filteredNodes,
      edges: filteredEdges,
    };
  }, [drilldownPath, normalizedChunk, authoredViews]);

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

  const requestedSemanticLevel = lockedLevel != null ? Math.max(1, Math.min(5, lockedLevel)) : resolveRequestedSemanticLevel(zoomLevel);
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

  const displayMode = (drilledView || activeSemanticView) ? "semantic" : "legacy";
  const effectiveView = drilledView || activeSemanticView;
  const layoutedDisplayNodes = effectiveView?.nodes || activeCluster?.nodes || layoutedNodes;
  const displayEdges = effectiveView?.edges || activeCluster?.edges || rfEdges;
  const clusterLevelLabel = effectiveView?.label || activeCluster?.label || null;

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

  // Report the current drill focus so the host header can show the title/summary
  // of the part being navigated (null = back at the whole-conversation level).
  useEffect(() => {
    if (!onFocusChange) return;
    if (!drilldownPath.length) {
      onFocusChange(null);
      return;
    }
    const tail = drilldownPath[drilldownPath.length - 1];
    const node = normalizedChunk.find((n) => n.id === tail.nodeId);
    onFocusChange({
      id: tail.nodeId,
      title: node?.node_name || tail.nodeName || "",
      summary: node?.summary || "",
      level: tail.level,
      depth: drilldownPath.length,
    });
  }, [drilldownPath, normalizedChunk, onFocusChange]);

  // Auto-fit the viewport when the displayed semantic tier changes (e.g.
  // initial mount lands on arcs but the camera was anchored on the
  // chunk-level layout — leaving arc nodes off-screen until the user
  // clicks Center). Fires once per tier change; defers one paint so React
  // Flow has the new node positions in its store before measuring.
  // Live-streaming nuance: if consolidation produces a new tier mid-
  // stream, this will yank the camera to that tier's nodes. Acceptable
  // for now since tier-emergence is a rare one-time event per session.
  const lastFittedSemanticLevelRef = useRef(null);
  useEffect(() => {
    // Compose a fit-key from displayMode + visible-tier + drilldown depth so
    // drilling INTO a parent re-fits even when the user's locked tier didn't
    // change. The drill path's tail id stops the fit from re-firing on
    // unrelated re-renders (e.g. selectedNode toggle).
    const drillKey = drilldownPath.length
      ? `${drilldownPath.length}:${drilldownPath[drilldownPath.length - 1].nodeId}`
      : "";
    const tierKey = displayMode === "semantic" ? `s${effectiveSemanticLevel}` : null;
    if (tierKey == null) return;
    const key = `${tierKey}|${drillKey}`;
    if (lastFittedSemanticLevelRef.current === key) return;
    lastFittedSemanticLevelRef.current = key;
    const id = setTimeout(() => {
      reactFlow.fitView({
        padding: 0.15,
        duration: reduceMotion ? 0 : 300,
        minZoom: MIN_READABLE_ZOOM,
      });
    }, 50);
    return () => clearTimeout(id);
  }, [displayMode, effectiveSemanticLevel, drilldownPath, reactFlow, reduceMotion]);

  // Controlled node state — layout provides initial positions, drags persist
  const [interactiveNodes, setInteractiveNodes] = useState([]);
  const layoutKeyRef = useRef("");

  const pendingFitViewRef = useRef(false);
  // Becomes true once the first real fitView has framed the graph on load.
  // Gates the auto-follow auto-pan (below) so it cannot yank the camera to
  // the last node before the initial tier fit runs — the cause of the
  // "empty canvas until you click Center" bug on a cold-open `?src=` load.
  const hasInitiallyFitRef = useRef(false);

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

  const baseDisplayNodes = interactiveNodes.length > 0 ? interactiveNodes : layoutedDisplayNodes;
  // ADR-032 Part B pattern 3: when argument-scaffold trace is active,
  // dim non-traced nodes + edges. Untraced opacity 0.18 keeps them
  // discoverable (you can still see their layout) without competing
  // for attention. Selected payoff node + its ancestors stay at full.
  const displayNodes = useMemo(() => {
    if (!traceResult.nodes) return baseDisplayNodes;
    return baseDisplayNodes.map((n) => {
      const inTrace = traceResult.nodes.has(n.id);
      return {
        ...n,
        style: {
          ...(n.style || {}),
          opacity: inTrace ? 1 : 0.18,
          transition: "opacity 200ms ease",
        },
      };
    });
  }, [baseDisplayNodes, traceResult.nodes]);

  // momentCount = raw L1 total, shown as a size signal in the count readout.
  // Suppressed when L1 is the active tier (else it reads "134 moments · 134 moments").
  const momentCount = useMemo(
    () => normalizedChunk.filter((n) => getAuthoredSemanticLevel(n) === 1).length,
    [normalizedChunk],
  );
  const semanticTierSpec = AUTHORED_LEVELS.find((s) => s.level === effectiveView?.level);
  const semanticTierWord = displayNodes.length === 1
    ? (semanticTierSpec?.singular || "node")
    : (semanticTierSpec?.label || "nodes");
  const semanticCountLabel = `${displayNodes.length} ${semanticTierWord}`
    + (effectiveView?.level !== 1 && momentCount > 0
      ? ` · ${momentCount} moment${momentCount === 1 ? "" : "s"}`
      : "");

  const displayEdgesWithTrace = useMemo(() => {
    if (!traceResult.edges) return displayEdges;
    return displayEdges.map((edge) => {
      const inTrace = traceResult.edges.has(edge.id);
      return {
        ...edge,
        style: {
          ...(edge.style || {}),
          opacity: inTrace ? 1 : 0.08,
          strokeWidth: inTrace ? Math.max(2, edge.style?.strokeWidth || 1.5) : edge.style?.strokeWidth,
        },
      };
    });
  }, [displayEdges, traceResult.edges]);

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
        // The graph is now framed. Release the auto-follow gate so live
        // streaming can resume centering on new nodes, but only AFTER this
        // initial fit has run (prevents the cold-open off-screen camera).
        hasInitiallyFitRef.current = true;
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
      // Fall back to the CURRENTLY DISPLAYED tier's layout, not the
      // chunk-level `layoutedNodes`. A node shown at the arcs tier (y≈130)
      // also exists in the chunk dagre at y≈17000+; centering on that stale
      // coordinate parks the camera off-screen. `layoutedDisplayNodes` is the
      // tier the user is actually looking at (and equals `layoutedNodes` in
      // legacy mode), so this is strictly the correct-or-equal source.
      const fallbackNode = layoutedDisplayNodes.find((node) => node.id === nodeId) || null;
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
    [layoutedDisplayNodes, reactFlow]
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
    // Cold-open guard: autoFollow defaults true, so without this the mount
    // auto-pan fires before the initial fitView and parks the camera ~17000px
    // off-screen (empty canvas until "Center"). Every tier/drill handler
    // already clears auto-follow for this reason; this covers the one path
    // they missed — the very first load.
    if (!hasInitiallyFitRef.current) return;
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
      // Single-click opens the NodeDetail drawer (original behavior).
      // Drill-down moved to onNodeDoubleClick — see handleNodeDoubleClick.
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

  const handleNodeDoubleClick = useCallback(
    (_, node) => {
      // Double-click on a non-leaf drills into its children. Leaf nodes
      // (no children_ids) ignore the double-click — single-click already
      // opened their drawer on the first event.
      const fullData = node.data?.fullData || {};
      const childIds = Array.isArray(fullData.children_ids) ? fullData.children_ids : [];
      const ownLevel = Number(fullData.semantic_level || fullData.level || 1);
      if (childIds.length === 0 || ownLevel <= 1) return;
      autoFollowRef.current = false;
      setDrilldownPath((prev) => [
        ...prev,
        {
          level: ownLevel,
          nodeId: node.id,
          nodeName: fullData.node_name || node.data?.title || "(unnamed)",
        },
      ]);
      setSelectedCluster(null);
      setClickedEdge(null);
    },
    []
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

  const ZOOM_PRESETS = [
    { label: "Center", hint: "Bring all the nodes back into view", action: () => {
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
    <div className={`relative w-full h-full${chromeless ? " lct-graph-chromeless" : ""}`}>
      {/* ADR-032 Part B pattern 3: argument-scaffold trace banner.
          Appears at top-center when trace mode is active. */}
      {argumentTraceFrom && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-md bg-amber-50 border border-amber-300 shadow-md px-3 py-1.5 text-[11px] text-amber-900">
          <span className="font-medium">Argument scaffold:</span>
          <span className="max-w-[260px] truncate text-amber-700">
            {normalizedChunk.find((n) => n.id === argumentTraceFrom)?.node_name || "node"}
          </span>
          <span className="text-amber-400">·</span>
          <span className="text-amber-600">
            {traceResult.nodes ? `${traceResult.nodes.size - 1} ancestors` : "0 ancestors"}
          </span>
          <button
            type="button"
            onClick={() => setTraceBroaden((v) => !v)}
            className={`ml-2 rounded border px-2 py-0.5 text-[10px] transition-colors ${
              traceBroaden
                ? "bg-amber-200 border-amber-400 text-amber-900"
                : "bg-white border-amber-200 text-amber-700 hover:bg-amber-100"
            }`}
            title={traceBroaden ? "Strict: only logical edges" : "Broaden: include conversational + causal"}
          >
            {traceBroaden ? "Broadened" : "Broaden"}
          </button>
          <button
            type="button"
            onClick={() => { setArgumentTraceFrom?.(null); setTraceBroaden(false); }}
            className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[10px] text-amber-700 hover:bg-amber-100"
            title="Exit trace mode (Esc)"
          >
            Exit
          </button>
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdgesWithTrace}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
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

      {/* Zoom preset + graph display controls. Center stays out front (the
          recovery action); the secondary view toggles collapse behind a
          "Display" disclosure so the resting canvas stays calm (ADR-011) — a
          first-time recipient sees Center + Display, not a six-control cockpit.
          Native <details> keeps it keyboard-accessible with no extra state. */}
      <div className="absolute bottom-4 left-4 z-40 flex items-center gap-1">
        {ZOOM_PRESETS.map(({ label, action, hint }) => (
          <button
            key={label}
            onClick={action}
            title={hint || label}
            className="px-2 py-1 text-[10px] font-medium bg-white/90 border border-gray-200 rounded shadow-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            {label}
          </button>
        ))}
        <details className="relative">
          <summary
            className="cursor-pointer list-none flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-white/90 border border-gray-200 rounded shadow-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
            title="Show display options (follow, motion, edges, time order, color)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="4" x2="20" y1="9" y2="9" />
              <line x1="4" x2="20" y1="15" y2="15" />
              <circle cx="9" cy="9" r="2" />
              <circle cx="15" cy="15" r="2" />
            </svg>
            Display
          </summary>
          <div className="absolute bottom-full left-0 mb-2 flex flex-wrap items-center gap-1 bg-white/95 backdrop-blur rounded-lg shadow-md border border-gray-200 p-1.5 max-w-[calc(100vw-2rem)] animate-slideIn">
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
              title={
                autoFollow
                  ? "Auto-center: the view re-centers on new content as you navigate. Click for free pan."
                  : "Free pan: the view stays where you put it. Click to auto-center on new content."
              }
              className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
                autoFollow
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {autoFollow ? "Following" : "Follow"}
            </button>
            <button
              onClick={() => setReduceMotion((v) => !v)}
              title={
                reduceMotion
                  ? "Motion off: edges are static. Click to gently animate question/clarify edges."
                  : "Motion on: question & clarify edges pulse. Click to make everything static."
              }
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
              title={
                hideEdges
                  ? "Show the relationship edges (supports / rebuts / etc.) between nodes."
                  : "Hide all relationship edges for a cleaner, nodes-only view."
              }
              className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
                hideEdges
                  ? "bg-amber-50 border-amber-300 text-amber-700"
                  : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {hideEdges ? "Edges off" : "Edges on"}
            </button>
            {/* ADR-032 Part C: temporal edges hidden by default. The spatial
                X position of nodes already encodes time — rendering temporal
                arrows on top is redundant. Toggle on if you want to see the
                successor chain explicitly. */}
            <button
              onClick={() => handleShowTemporalEdgesChange(!showTemporalEdges)}
              title={
                showTemporalEdges
                  ? "Hide time-order arrows (left-to-right position already shows order)."
                  : "Show arrows linking each point to the next one in time."
              }
              disabled={hideEdges}
              className={`px-2 py-1 text-[10px] font-medium border rounded shadow-sm transition-colors ${
                hideEdges
                  ? "bg-gray-100 border-gray-200 text-gray-300 cursor-not-allowed"
                  : showTemporalEdges
                    ? "bg-blue-50 border-blue-300 text-blue-700"
                    : "bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {showTemporalEdges ? "Time order on" : "Time order off"}
            </button>
            <span className="mx-0.5 select-none text-[9px] text-gray-300">|</span>
            <ColorModeToggle mode={colorMode} onChange={handleColorModeChange} />
          </div>
        </details>
      </div>

      {/* Zoom / cluster HUD — top-left */}
      <div className="absolute top-3 left-3 right-3 z-40 flex items-center gap-2 select-none overflow-x-auto flex-nowrap whitespace-nowrap">
        <div className="flex-shrink-0 flex items-center gap-1.5 rounded-md bg-white/90 backdrop-blur border border-gray-200 shadow-sm px-2.5 py-1.5">
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
                  ? semanticCountLabel
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
        {/* Drill-down breadcrumb — click any crumb to jump back to that level. */}
        {drilldownPath.length > 0 && (
          <div className="flex-shrink-0 flex items-center gap-1 text-[11px] text-gray-600 bg-white/90 backdrop-blur border border-gray-200 shadow-sm rounded-md px-2 py-1">
            <button
              type="button"
              className="text-blue-600 hover:underline font-medium cursor-pointer"
              onClick={() => {
                autoFollowRef.current = false;
                setDrilldownPath([]);
              }}
              title="Back to top tier"
            >
              {AUTHORED_LEVELS.find((spec) => spec.level === (lockedLevel ?? drilldownPath[0]?.level))?.label || "top"}
            </button>
            {drilldownPath.map((crumb, idx) => (
              <span key={`${crumb.nodeId}-${idx}`} className="flex items-center gap-1">
                <span className="text-gray-400">/</span>
                <button
                  type="button"
                  className={
                    idx === drilldownPath.length - 1
                      ? "text-gray-900 font-medium cursor-default"
                      : "text-blue-600 hover:underline cursor-pointer"
                  }
                  onClick={() => {
                    if (idx === drilldownPath.length - 1) return;
                    autoFollowRef.current = false;
                    setDrilldownPath((prev) => prev.slice(0, idx + 1));
                  }}
                  title={crumb.nodeName}
                >
                  {crumb.nodeName.length > 28 ? `${crumb.nodeName.slice(0, 28)}…` : crumb.nodeName}
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Zoom scale — click to lock semantic or clustered level, click again to unlock */}
        <div className="flex-shrink-0 flex items-center gap-0 rounded-md bg-white/90 backdrop-blur border border-gray-200 shadow-sm overflow-hidden">
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
                  // Switching tiers exits any drill-down context — the user
                  // wants the FULL tier view, not a filtered subset.
                  setDrilldownPath([]);
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
            <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2.5 py-1.5 bg-white/85 hover:bg-white/95 backdrop-blur rounded-full shadow-sm border border-gray-200 text-gray-500 hover:text-gray-700 transition opacity-80 hover:opacity-100 text-[10px] font-medium">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Colors
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
  onFocusChange: PropTypes.func,
  chromeless: PropTypes.bool,
  conversationId: PropTypes.string,
  initialColorMode: PropTypes.oneOf(COLOR_MODES),
  initialShowTemporalEdges: PropTypes.bool,
  argumentTraceFrom: PropTypes.string,
  setArgumentTraceFrom: PropTypes.func,
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
  onFocusChange: PropTypes.func,
  chromeless: PropTypes.bool,
  conversationId: PropTypes.string,
  initialColorMode: PropTypes.oneOf(COLOR_MODES),
  initialShowTemporalEdges: PropTypes.bool,
  argumentTraceFrom: PropTypes.string,
  setArgumentTraceFrom: PropTypes.func,
};
