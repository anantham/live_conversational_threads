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
import {
  layoutByThread,
  layoutDialectic,
  layoutMacroGraph,
  layoutWithDagre,
} from "./graphLayout";
import { projectSemanticEdgesToLevel } from "./macroGraphProjection";
import {
  extractContextualRelationEntries,
  getAuthoredSemanticLevel,
  normalizeGraphNode,
  resolveRequestedSemanticLevel,
} from "./graphNormalization";
import { saveConversationDraft } from "../services/apiClient";
import {
  explicitEdgeKind,
  explicitEdgeRenderEndpoints,
  indexExplicitEdges,
} from "../services/edgeContract";
import ConversationNode from "./graph/ConversationNode";
import {
  COLOR_MODES,
  DEFAULT_COLOR_MODE,
  buildSpeakerColorMapForNodes,
  buildTemporalColorMapForNodes,
  buildArgumentStatusMapForNodes,
  buildDateColorMapForNodes,
  buildThreadColorMapForNodes,
  resolveNodeColors,
} from "./graph/colorModes";
import ColorModeToggle from "./graph/ColorModeToggle";
import ModeLegend from "./graph/ModeLegend";
import MinimalGraphHud from "./graph/MinimalGraphHud";
import MinimalGraphPanels from "./graph/MinimalGraphPanels";
import { mglog } from "./graph/minimalGraphDebug";
import { MIN_READABLE_ZOOM, repackSubset } from "./graphSimilarityLayout";
import {
  COMPACT_VIEWER_QUERY,
  mediaQueryMatches,
  useMediaQuery,
} from "../hooks/useMediaQuery";

// ADR-030 §D4: custom node renderer with three color modes + state markers.
// Cluster nodes are still default ReactFlow rendering (separate concern).
const NODE_TYPES = { conversational: ConversationNode };
const EDGE_TYPES = {};

function frameNodesFromTopLeft(
  reactFlow,
  nodes,
  { zoom, duration = 0, padding = 24, paddingX = padding, paddingY = padding },
) {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  let minX = Infinity;
  let minY = Infinity;
  nodes.forEach((node) => {
    const x = node?.position?.x;
    const y = node?.position?.y;
    if (Number.isFinite(x) && x < minX) minX = x;
    if (Number.isFinite(y) && y < minY) minY = y;
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false;
  reactFlow.setViewport(
    { x: -minX * zoom + paddingX, y: -minY * zoom + paddingY, zoom },
    { duration },
  );
  return true;
}

function MinimalGraphInner({
  graphData,
  semanticEdges,
  selectedNode,
  setSelectedNode,
  focusNode,
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
  const mobileFramedNodeSetRef = useRef("");
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() =>
    mediaQueryMatches("(prefers-reduced-motion: reduce)"),
  );
  const compactViewer = useMediaQuery(COMPACT_VIEWER_QUERY);
  const [hideEdges, setHideEdges] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [lockedLevel, setLockedLevel] = useState(null); // null = unlocked, semantic 1-4 or legacy 0-3
  const initialLockedAppliedRef = useRef(false);
  // True once the USER has explicitly chosen a tier or driven the camera
  // (locked/unlocked a tier, or manually zoomed/panned). Until then we force
  // the synchronously-computed landing tier so a cold open can never fall
  // through to the zoom=1 -> finest mapping (which builds the tall chunk
  // layout and strands the camera). Survives remounts correctly: a fresh
  // instance starts false, so it re-forces the landing tier instead of the
  // finest one. See requestedSemanticLevel + initialLandingLevel.
  const userOverrodeTierRef = useRef(false);
  // Timestamp of the last drill â€” debounces an accidental double-click so a
  // single tap (= expand, instant) can't fire twice. There is no double-tap
  // gesture (Option A): single tap expands; a leaf single-tap opens its drawer;
  // the per-card "details" chip opens the drawer for a node that has children.
  const lastDrillAtRef = useRef(0);
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
  // so NodeDetail can trigger trace via "â†‘ Trace ancestors" button.
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

  const normalizedChunk = useMemo(() => {
    const normalized = allNodes
      .map((item, index) => normalizeGraphNode(item, index))
      .filter(Boolean);
    return indexExplicitEdges(normalized, semanticEdges, Array.isArray(semanticEdges));
  }, [allNodes, semanticEdges]);
  mglog("normalizedChunk", { allNodes: allNodes.length, normalized: normalizedChunk.length, graphDataLen: (graphData || []).length });

  // Default landing tier: the TOPMOST populated tier so the canvas opens on
  // the macro view (1-5 arcs / themes), not 100+ chunks. User can step down
  // via the tier-lock UI or by clicking into nodes. Earlier heuristic
  // demanded >=2.5x compression vs the next tier, but on conversations
  // where the LLM produces equal counts at L4 and L5 (no genuine
  // compression â€” 772ac0cc: 4 themes -> 4 arcs) it landed at L2, which
  // defeats the point. Pick the highest tier with content; if that tier
  // only has 1 node and a finer tier exists, drop down to the finer one.
  //
  // COLD-OPEN CAMERA FIX: this is computed SYNCHRONOUSLY (useMemo) and used as
  // the initial requestedSemanticLevel fallback below â€” so render 0 already
  // lays out the macro tier (e.g. 3 arcs) instead of the finest tier (e.g.
  // 2190 chunks, ~719000px tall). Previously the finest layout rendered on
  // render 0, a fitView parked the camera at its center (~y 359000), and the
  // post-paint tier flip's fit got cancelled before committing â€” leaving the
  // canvas blank until the user clicked something. One source of truth now.
  const initialLandingLevel = useMemo(() => {
    if (!normalizedChunk || normalizedChunk.length === 0) return null;
    const byLevel = new Map();
    normalizedChunk.forEach((n) => {
      const level = Number(n.semantic_level);
      if (!Number.isFinite(level) || level < 1 || level > 5) return;
      byLevel.set(level, (byLevel.get(level) || 0) + 1);
    });
    if (byLevel.size === 0) return null;
    // Walk top-down. Land at the topmost tier with at least 1 node, UNLESS
    // that tier has only 1 node and a finer tier exists with more â€” in
    // that case prefer the finer tier so the user sees parallelism.
    for (let lvl = 5; lvl >= 1; lvl--) {
      const cur = byLevel.get(lvl) || 0;
      if (cur < 1) continue;
      const next = byLevel.get(lvl - 1) || 0;
      if (cur === 1 && next >= 2) return lvl - 1; // solo macro node: drop one tier
      return lvl;
    }
    return null;
  }, [normalizedChunk]);

  // Reflect the landing tier into the tier-lock UI (one render later). The
  // visible tier on render 0 already matches via requestedSemanticLevel, so
  // this no longer causes a node-set flip â€” it just lights up the lock chip.
  useEffect(() => {
    if (initialLockedAppliedRef.current) return;
    if (initialLandingLevel == null) return;
    mglog("auto-landing setLockedLevel", { chosen: initialLandingLevel });
    setLockedLevel(initialLandingLevel);
    initialLockedAppliedRef.current = true;
  }, [initialLandingLevel]);

  // ADR-030 §D4: build all three color maps; the active mode picks among them.
  // No more auto-switching based on speaker count â€” user controls via toggle.
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
  // Thread/debate map: id -> categorical color per thread_id (the default mode).
  const threadColorMap = useMemo(
    () => buildThreadColorMapForNodes(normalizedChunk),
    [normalizedChunk]
  );

  // Tap-friendly drill-down. Same fan-out as handleNodeDoubleClick, but callable
  // from a node's âŠ• control by id â€” so it works on touch (double-tap is eaten by
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

  // Open the NodeDetail drawer for a node by id. Used by the per-card "details"
  // chip and by a leaf single-tap (a leaf has nothing to expand). Defined early
  // (only needs setSelectedNode, a stable prop) so buildRfNodesForSource can
  // pass it down to ConversationNode.
  const handleOpenDetails = useCallback(
    (nodeId) => {
      autoFollowRef.current = false;
      setSelectedNode((prev) => (prev === nodeId ? null : nodeId));
    },
    [setSelectedNode]
  );

  // Escape pops one drill level (mirrors the â† Back button). Gated on no active
  // argument-trace so it doesn't fight that mode's own Escape handler.
  useEffect(() => {
    if (drilldownPath.length === 0 || argumentTraceFrom) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        autoFollowRef.current = false;
        setDrilldownPath((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drilldownPath.length, argumentTraceFrom]);

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
        threadColorMap,
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

      // Recipient artifacts carry structured moment turns so speaker identity
      // can be shown by stable color markers without repeating names in prose.
      const speakerTurns = Array.isArray(item.source_turns) ? item.source_turns : [];

      // Speaker badge (prefer renamed display name over raw id)
      const speaker = item.speaker_display || item.speaker_id || "";
      const speakerLabel = speakerTurns.length > 0 ? "" : isDraftNode
        ? (speaker ? `${speaker} · provisional` : "provisional")
        : speaker;

      // Authored state markers per ADR-030 §D4. Frontend renders only what
      // the backend authored; never invents these flags.
      const isTangent = Boolean(item.is_tangent);
      const isCrux = Boolean(item.is_crux);
      const isBookmark = Boolean(item.is_bookmark);
      const isContextualProgress = Boolean(item.is_contextual_progress);

      // Conversation-dimension markers (action_item / surprise / agreement /
      // disagreement). Rendered as a compact chip strip in ConversationNode â€”
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
          speakerTurns,
          speakerColorMap,
          speakerLabel,
          fillColor: fill,
          borderColor: border,
          isDraft: isDraftNode,
          isTangent,
          isCrux,
          isBookmark,
          isContextualProgress,
          dimensionMarkers,
          // Tap-to-fan-out: non-leaf nodes above the chunk tier get a âŠ• control
          // that drills into just this node's children (see handleExpand).
          canExpand:
            Array.isArray(item.children_ids) &&
            item.children_ids.length > 0 &&
            Number(item.semantic_level || item.level || 1) > 1,
          expandCount: Array.isArray(item.children_ids) ? item.children_ids.length : 0,
          onExpand: () => handleExpand(item.id),
          // Option A: a small "details" chip on nodes that have children opens
          // the drawer (their card-tap expands instead of opening it).
          onOpenDetails: () => handleOpenDetails(item.id),
          // Rhetoric layer (Phase 2): argumentative role + verified flags drive
          // the card chips + the Rhetoric color lens.
          argumentRole: item.argument_role || null,
          rhetoricFlags: Array.isArray(item.rhetoric_flags) ? item.rhetoric_flags : [],
          argStatusLabel,
          // fullData kept for downstream consumers (NodeDetail panel etc.)
          fullData: item,
        },
      };
    });
  }, [colorMode, speakerColorMap, temporalColorMap, argumentStatusMap, dateColorMap, threadColorMap, handleExpand, handleOpenDetails]);

  const buildRfEdgesForSource = useCallback((sourceNodes, { ignoreHidden = false } = {}) => {
    if (hideEdges && !ignoreHidden) return [];

    const edges = [];
    const seenEdgeKeys = new Set();
    const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));

    sourceNodes.forEach((item) => {
      const hasExplicitContract =
        Array.isArray(item.explicit_edges_out) && Array.isArray(item.explicit_edges_in);
      // ADR-032 Part C: temporal edges are persisted in the data model
      // but hidden by default. Spatial X-position already encodes time
      // via the swim-lane layout (`timeBased: true`); rendering temporal
      // arrows on top would be visual noise. Reveal them only when the
      // per-conversation toggle is on (showTemporalEdges, default false).
      if (!hasExplicitContract && item.successor && showTemporalEdges) {
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

      // Version 2 uses explicit source/target endpoints. Legacy artifacts keep
      // the historical node-local edge_relations interpretation.
      const relations = hasExplicitContract
        ? item.explicit_edges_out
        : (Array.isArray(item.edge_relations) ? item.edge_relations : []);
      relations.forEach((rel) => {
        const targetName = String(rel?.related_node || "").trim();
        const targetLower = targetName.toLowerCase();
        const related = hasExplicitContract
          ? nodeById.get(String(rel?.to_node_id || ""))
          : sourceNodes.find((n) => n.node_name === targetName)
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
        const category = hasExplicitContract && explicitEdgeKind(rel) === "temporal"
          ? "temporal"
          : categorizeEdgeRelation(relType);
        if (category === "temporal" && !showTemporalEdges) return;
        const catStyle = EDGE_CATEGORY_STYLES[category] || EDGE_CATEGORY_STYLES.other;
        const isConnectedToSelected = selectedNode === item.id || selectedNode === related.id;

        const rolledRelationCounts = rel?.rollup_level && rel?.relation_counts
          ? Object.entries(rel.relation_counts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          : [];
        const edgeLabel = rolledRelationCounts.length > 0
          ? `${rolledRelationCounts.slice(0, 2).map(([type, count]) => `${count} ${type.replace(/_/g, " ")}`).join(" · ")}${rolledRelationCounts.length > 2 ? ` · +${rolledRelationCounts.length - 2}` : ""}`
          : relType && relType !== "contextual"
            ? relType.replace(/_/g, " ")
            : "";

        // Explicit edges are directed: never sort endpoints or collapse A→B
        // with B→A. Legacy IDs retain the historical pair deduplication.
        const pairKey = [item.id, related.id].sort().join("--");
        const edgeId = hasExplicitContract
          ? `x-${rel.id || `${item.id}-${related.id}-${relType}`}`
          : `c-${pairKey}-${relType}`;
        if (seenEdgeKeys.has(edgeId)) return;
        seenEdgeKeys.add(edgeId);
        const explicitEndpoints = hasExplicitContract
          ? explicitEdgeRenderEndpoints(rel)
          : null;
        edges.push({
          id: edgeId,
          source: explicitEndpoints?.source || related.id,
          target: explicitEndpoints?.target || item.id,
          // Only "soft" relation types animate (asks/clarifies). Solid
          // logical edges (supports/rebuts/implies) stay static â€” they're
          // structural claims, not transient signals.
          animated: !reduceMotion && (category === "conversational-q" || category === "conversational-flow"),
          label: edgeLabel || undefined,
          labelStyle: { fontSize: 9, fill: "#64748b", fontFamily: "Inter, sans-serif" },
          labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
          labelBgPadding: [4, 2],
          data: {
            relationType: relType,
            relationText: rel.explanation || rel.relation_text || "",
            category,
            sourceLabel: hasExplicitContract ? item.node_name : related.node_name,
            targetLabel: hasExplicitContract ? related.node_name : item.node_name,
            aggregateWeight: Number(rel.aggregate_weight) || 1,
            underlyingEdgeCount: Number(rel.underlying_edge_count) || 1,
            relationCounts: rel.relation_counts || null,
            rollupLevel: rel.rollup_level || null,
          },
          style: {
            stroke: isConnectedToSelected ? "#f59e0b" : catStyle.stroke,
            strokeWidth: isConnectedToSelected
              ? 2.5
              : (catStyle.strokeWidth || 1.5) + Math.min(1.5, Math.log2((Number(rel.underlying_edge_count) || 1) + 1) * 0.35),
            strokeDasharray: catStyle.strokeDasharray,
            opacity: isConnectedToSelected ? 1 : 0.7,
            transition: reduceMotion ? "none" : "all 0.2s ease",
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
      if (!hasExplicitContract && relations.length === 0 && item.contextual_relation) {
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

  // Build ReactFlow nodes â€” card-style with title + summary
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
    let timeBasedLayout = true;
    const tsValues = normalizedChunk
      .map((n) => Number(n.timestamp_start))
      .filter((v) => Number.isFinite(v));
    const tsEndValues = normalizedChunk
      .map((n) => Number(n.timestamp_end))
      .filter((v) => Number.isFinite(v));
    if (tsValues.length > 0 && tsEndValues.length > 0) {
      const totalDuration = Math.max(...tsEndValues) - Math.min(...tsValues);
      if (totalDuration > 48 * 3600) {
        // ADR-032's time-axis assumed session-scale durations, where dormancy
        // gaps are meaningful at a single px/s. Wall-clock imports (e.g. a
        // month-long WhatsApp export with epoch timestamps) degenerate: a
        // 30-day span at the 2px/s floor is ~5M px of mostly-empty timeline.
        // Beyond a working-session horizon, use the column layout instead —
        // chronological order is preserved, dead time is dropped.
        timeBasedLayout = false;
      } else if (totalDuration > 0) {
        pixelsPerSecond = Math.max(2, Math.min(20, 3000 / totalDuration));
      }
    }

    return AUTHORED_LEVELS.reduce((acc, spec) => {
      const levelNodes = normalizedChunk.filter((node) => getAuthoredSemanticLevel(node) === spec.level);
      if (levelNodes.length === 0) {
        acc[spec.level] = null;
        return acc;
      }
      const isMacroTier = spec.level >= 3;
      const quotient = isMacroTier && Array.isArray(semanticEdges)
        ? projectSemanticEdgesToLevel(normalizedChunk, semanticEdges, spec.level)
        : null;
      const projectedLevelNodes = quotient
        ? indexExplicitEdges(levelNodes, quotient.edges, true)
        : levelNodes;
      const rfLevelNodes = buildRfNodesForSource(projectedLevelNodes);
      // Macro geometry must remain stable when the user merely hides lines.
      // Build structural edges for layout first, then apply visual visibility.
      const structuralLevelEdges = buildRfEdgesForSource(
        projectedLevelNodes,
        { ignoreHidden: isMacroTier },
      );
      const visibleLevelEdges = hideEdges && isMacroTier ? [] : structuralLevelEdges;
      acc[spec.level] = {
        level: spec.level,
        label: spec.label,
        type: spec.type,
        nodes: levelNodes.length <= 1
          ? rfLevelNodes
          : isMacroTier
            ? layoutMacroGraph(rfLevelNodes, structuralLevelEdges, {
                nodeWidth: 480,
                // Macro summaries use the same full-prose card renderer as
                // lower tiers; reserve its measured worst-case footprint.
                nodeHeight: 360,
                nodesep: 90,
                ranksep: 170,
              })
            : layoutByThread(
                rfLevelNodes,
                structuralLevelEdges,
                {
                  // Moments and ideas retain ADR-032's temporal swim lanes:
                  // X=time, Y=thread. Macro tiers use the quotient graph above.
                  nodeWidth: 480,
                  nodeHeight: 360,
                  timeBased: timeBasedLayout,
                  pixelsPerSecond,
                  minNodeWidth: 320,
                }
              ),
        edges: visibleLevelEdges,
        projectionStats: quotient?.stats || null,
      };
      return acc;
    }, {});
  }, [
    buildRfEdgesForSource,
    buildRfNodesForSource,
    hasAuthoredHierarchy,
    hideEdges,
    normalizedChunk,
    semanticEdges,
  ]);

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
      if (Array.isArray(item.explicit_edges_out) && Array.isArray(item.explicit_edges_in)) {
        item.explicit_edges_out.forEach((edge) => {
          const targetId = String(edge?.to_node_id || "");
          if (!targetId) return;
          const category = explicitEdgeKind(edge) === "temporal"
            ? "temporal"
            : categorizeEdgeRelation(edge.relation_type || "contextual");
          const arr = incomingByTarget.get(targetId) || [];
          arr.push({
            fromId: item.id,
            category,
            relType: edge.relation_type || "contextual",
            edgeId: `x-${edge.id || `${item.id}-${targetId}-${edge.relation_type || "contextual"}`}`,
          });
          incomingByTarget.set(targetId, arr);
        });
        return;
      }
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
        // want incoming edges TO each node â€” so the source-of-edge is
        // ``item`` (which "supports" targetNode), and targetNode receives.
        const arr = incomingByTarget.get(targetNode.id) || [];
        arr.push({
          fromId: item.id,
          category,
          relType: rel.relation_type || "contextual",
          edgeId: null,
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
        // Edge id mirrors what buildRfEdgesForSource produced â€” the
        // pair-key + relType pattern.
        const pairKey = [edge.fromId, id].sort().join("--");
        tracedEdges.add(edge.edgeId || `c-${pairKey}-${edge.relType}`);
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
      nodes: repackSubset(filteredNodes, filteredEdges),
      edges: filteredEdges,
    };
  }, [drilldownPath, normalizedChunk, authoredViews]);

  // Scoped tier view: when the user has drilled into a node and then taps a
  // DEEPER tier (e.g. "moments"/"ideas" while inside a theme), show only that
  // node's descendants at the chosen level â€” not the whole global tier. This is
  // what makes a large combined corpus navigable: drill a theme, then "moments"
  // shows that theme's moments, not all of them.
  const scopedTierView = useMemo(() => {
    if (drilldownPath.length === 0 || lockedLevel == null) return null;
    const tail = drilldownPath[drilldownPath.length - 1];
    if (lockedLevel >= tail.level) return null; // only scope when going deeper
    const byId = new Map(normalizedChunk.map((n) => [n.id, n]));
    const ids = new Set();
    const stack = [tail.nodeId];
    while (stack.length) {
      const n = byId.get(stack.pop());
      if (!n) continue;
      for (const c of n.children_ids || []) {
        const cn = byId.get(c);
        if (!cn) continue;
        if (Number(cn.semantic_level) === lockedLevel) ids.add(c);
        else stack.push(c);
      }
    }
    if (!ids.size) return null;
    const tv = authoredViews[lockedLevel];
    if (!tv) return null;
    const nodes = (tv.nodes || []).filter((n) => ids.has(n.id));
    if (!nodes.length) return null;
    const allow = new Set(nodes.map((n) => n.id));
    const edges = (tv.edges || []).filter((e) => allow.has(e.source) && allow.has(e.target));
    const spec = AUTHORED_LEVELS.find((s) => s.level === lockedLevel);
    return { level: lockedLevel, label: spec?.label || `level ${lockedLevel}`, type: spec?.type || "node", nodes: repackSubset(nodes, edges), edges, scoped: true };
  }, [drilldownPath, lockedLevel, normalizedChunk, authoredViews]);

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

  // Before the user touches the tier-lock/zoom, fall back to the synchronously
  // computed landing tier (not the zoom=1 -> finest mapping). This is what
  // makes render 0 open on the macro tier and keeps the camera framed. After
  // the auto-landing effect applies (initialLockedAppliedRef), an explicit
  // UNLOCK returns to zoom-driven resolution as before.
  const requestedSemanticLevel = lockedLevel != null
    ? Math.max(1, Math.min(5, lockedLevel))
    : (!userOverrodeTierRef.current && initialLandingLevel != null
        ? initialLandingLevel
        : resolveRequestedSemanticLevel(zoomLevel));
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

  const displayMode = (scopedTierView || drilledView || activeSemanticView) ? "semantic" : "legacy";
  const effectiveView = scopedTierView || drilledView || activeSemanticView;
  const layoutedDisplayNodes = effectiveView?.nodes || activeCluster?.nodes || layoutedNodes;
  const displayEdges = effectiveView?.edges || activeCluster?.edges || rfEdges;
  const clusterLevelLabel = effectiveView?.label || activeCluster?.label || null;
  mglog("view-select", { lockedLevel, zoomLevel, requestedSemanticLevel, effectiveSemanticLevel, hasAuthoredHierarchy, authoredLevels: authoredSemanticLevels, displayMode, src: effectiveView ? "effectiveView" : (activeCluster ? "activeCluster" : "layoutedNodes(chunk)"), nodeCount: layoutedDisplayNodes.length });
  mglog("layoutedDisplayNodes", { count: layoutedDisplayNodes.length, firstY: layoutedDisplayNodes[0]?.position?.y, lastY: layoutedDisplayNodes[layoutedDisplayNodes.length - 1]?.position?.y });

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
  // chunk-level layout â€” leaving arc nodes off-screen until the user
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
    mglog("tier-change fit", { tierKey, drillKey, prev: lastFittedSemanticLevelRef.current, willFit: lastFittedSemanticLevelRef.current !== key });
    if (lastFittedSemanticLevelRef.current === key) return;
    lastFittedSemanticLevelRef.current = key;
    const id = setTimeout(() => {
      const duration = reduceMotion ? 0 : 300;
      if (compactViewer) return;
      reactFlow.fitView({ padding: 0.15, duration, minZoom: MIN_READABLE_ZOOM });
    }, 50);
    return () => clearTimeout(id);
  }, [compactViewer, displayMode, effectiveSemanticLevel, drilldownPath, layoutedDisplayNodes, reactFlow, reduceMotion]);

  // Controlled node state â€” layout provides initial positions, drags persist
  const [interactiveNodes, setInteractiveNodes] = useState([]);
  const layoutKeyRef = useRef("");

  const pendingFitViewRef = useRef(false);
  // Becomes true once the first real fitView has framed the graph on load.
  // Gates the auto-follow auto-pan (below) so it cannot yank the camera to
  // the last node before the initial tier fit runs â€” the cause of the
  // "empty canvas until you click Center" bug on a cold-open `?src=` load.
  const hasInitiallyFitRef = useRef(false);

  useEffect(() => {
    // Generate a key from node IDs to detect when the node set changes
    const key = layoutedDisplayNodes.map((n) => n.id).join(",");
    if (key !== layoutKeyRef.current) {
      mglog("layout re-key -> arm fitView", { count: layoutedDisplayNodes.length, key: key.slice(0, 60), prevKey: layoutKeyRef.current.slice(0, 60) });
      layoutKeyRef.current = key;
      setInteractiveNodes(layoutedDisplayNodes.map((n) => ({ ...n, draggable: true })));
      pendingFitViewRef.current = true;
      return;
    }
    // Same node set â€” merge fresh `data` and `type` into existing nodes so
    // updates that don't change node identity (e.g. color-mode toggle, draft
    // â†’ stable transitions, authored-flag updates) take effect without
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

  // Weakness lenses: one-click "where is the argument weak" filters computed
  // from incoming supports/rebuts (argumentStatusMap) + argument_role. A match
  // set also keeps its ANCESTORS visible (parent_id walk) so the filter stays
  // meaningful at coarser tiers ("this theme contains unsupported claims").
  const [weaknessFilter, setWeaknessFilter] = useState(null);
  const weaknessSets = useMemo(() => {
    const parentOf = new Map(
      normalizedChunk.map((n) => [n.id, n.parent_id || null])
    );
    const withAncestors = (set) => {
      const out = new Set(set);
      set.forEach((id) => {
        let p = parentOf.get(id);
        let hops = 0;
        while (p && !out.has(p) && hops < 6) {
          out.add(p);
          p = parentOf.get(p);
          hops += 1;
        }
      });
      return out;
    };
    const unsupported = new Set();
    const uncontested = new Set();
    const battleground = new Set();
    const questions = new Set();
    const contradictions = new Set();
    const idByName = new Map();
    normalizedChunk.forEach((n) => {
      if (n.node_name) idByName.set(String(n.node_name).toLowerCase(), n.id);
    });
    normalizedChunk.forEach((n) => {
      const st = argumentStatusMap[n.id] || {};
      const sup = st.sup || 0;
      const reb = st.reb || 0;
      // With argument_role data, "claim" nodes are the auditable population;
      // without it (older graphs), fall back to level-2 idea nodes.
      const isClaim = n.argument_role
        ? n.argument_role === "claim"
        : getAuthoredSemanticLevel(n) === 2;
      if (isClaim && sup === 0) unsupported.add(n.id);
      if (isClaim && reb === 0) uncontested.add(n.id);
      if (sup > 0 && reb > 0) battleground.add(n.id);
      if (
        n.argument_role === "question" ||
        (n.node_name || "").toLowerCase().startsWith("open question")
      ) {
        questions.add(n.id);
      }
      // Self-contradiction edges flag BOTH endpoints (edges are stored one
      // direction, later statement → earlier).
      const contradictionEdges = Array.isArray(n.explicit_edges_out)
        ? n.explicit_edges_out
        : (n.edge_relations || []);
      contradictionEdges.forEach((e) => {
        const rt = String(e?.relation_type || "").trim().toLowerCase();
        if (rt !== "contradicts") return;
        contradictions.add(n.id);
        const tid = Array.isArray(n.explicit_edges_out)
          ? String(e?.to_node_id || "")
          : idByName.get(String(e?.related_node || "").toLowerCase());
        if (tid) contradictions.add(tid);
      });
    });
    return {
      counts: {
        unsupported: unsupported.size,
        uncontested: uncontested.size,
        battleground: battleground.size,
        questions: questions.size,
        contradictions: contradictions.size,
      },
      visible: {
        unsupported: withAncestors(unsupported),
        uncontested: withAncestors(uncontested),
        battleground: withAncestors(battleground),
        questions: withAncestors(questions),
        contradictions: withAncestors(contradictions),
      },
    };
  }, [normalizedChunk, argumentStatusMap]);

  // ADR-032 Part B pattern 3 (+ dialectic layout): when argument-scaffold
  // trace is active, dim non-traced nodes AND re-lay out the graph with the
  // dialectic fan — focus at origin, supporters fanned left, rebutters right
  // (layoutDialectic reads incoming supports/rebuts from fullData, matching
  // the argument color mode). Untraced opacity 0.18 keeps the rest
  // discoverable without competing for attention. Positions revert when the
  // trace exits (baseDisplayNodes keeps the original layout).
  // With no trace active, the weakness lens (if any) dims non-matching nodes.
  const displayNodes = useMemo(() => {
    if (!traceResult.nodes) {
      const matchSet = weaknessFilter ? weaknessSets.visible[weaknessFilter] : null;
      if (!matchSet) return baseDisplayNodes;
      return baseDisplayNodes.map((n) => ({
        ...n,
        style: {
          ...(n.style || {}),
          opacity: matchSet.has(n.id) ? 1 : 0.15,
          transition: reduceMotion ? "none" : "opacity 200ms ease",
        },
      }));
    }
    const dimmed = baseDisplayNodes.map((n) => {
      const inTrace = traceResult.nodes.has(n.id);
      return {
        ...n,
        style: {
          ...(n.style || {}),
          opacity: inTrace ? 1 : 0.18,
          transition: reduceMotion ? "none" : "opacity 200ms ease",
        },
      };
    });
    return layoutDialectic(dimmed, [], { focusNodeId: argumentTraceFrom });
  }, [baseDisplayNodes, traceResult.nodes, weaknessFilter, weaknessSets, argumentTraceFrom, reduceMotion]);

  // ReactFlow measures nodes over several renders. Debounce until the visible
  // node set settles, then frame the first card at a readable phone zoom. The
  // key is recorded only after the frame commits, so interrupted renders retry
  // instead of getting stranded at ReactFlow's 0.3 minimum zoom.
  useEffect(() => {
    if (!compactViewer || displayNodes.length === 0) {
      return undefined;
    }
    const key = displayNodes.map((node) => node.id).join(",");
    if (mobileFramedNodeSetRef.current === key) return undefined;
    const id = window.setTimeout(() => {
      const liveNodes = reactFlow.getNodes?.() || displayNodes;
      if (frameNodesFromTopLeft(reactFlow, liveNodes, {
        zoom: 0.85,
        duration: reduceMotion ? 0 : 300,
        paddingX: 16,
        paddingY: 112,
      })) {
        mobileFramedNodeSetRef.current = key;
      }
    }, 180);
    return () => window.clearTimeout(id);
  }, [compactViewer, displayNodes, reactFlow, reduceMotion]);

  // Re-frame the camera when the dialectic fan appears/disappears — the node
  // set is unchanged (no layout re-key) but positions move drastically.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        reactFlow.fitView({ padding: 0.25, duration: reduceMotion ? 0 : 300 });
      } catch {
        /* canvas not ready — Center button remains the fallback */
      }
    }, 80);
    return () => clearTimeout(id);
  }, [argumentTraceFrom, reactFlow, reduceMotion]);

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
  // has measured their positions. A single rAF isn't enough â€” ReactFlow's
  // nodeInternals lags one render cycle on tab switches, so fitView with
  // no caps produces nonsense viewport (e.g. scale=1 + huge negative y).
  // Two rAFs + explicit minZoom/maxZoom caps fix tab-switch auto-fit.
  //
  // Never trade away legibility just to fit the complete graph at once.
  // Dense maps remain pannable; the initial camera frames their origin at a
  // readable scale on compact screens and clamps desktop fit to the same
  // effective-type floor.
  useEffect(() => {
    mglog("fitView gate", { willRun: pendingFitViewRef.current && displayNodes.length > 0, pending: pendingFitViewRef.current, displayNodes: displayNodes.length, hasInitiallyFit: hasInitiallyFitRef.current });
    if (!pendingFitViewRef.current || displayNodes.length === 0) return;
    // NB: do NOT consume pendingFitViewRef here. If the node set changes again
    // before the rAFs fire (e.g. a tier flip on cold open), this effect's
    // cleanup cancels them â€” consuming early would lose the fit entirely and
    // strand the camera. We consume only after the fit actually commits.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        programmaticMoveRef.current = true;
        const isCompact = compactViewer;
        if (isCompact) {
          // On mobile, fitView would either squish the whole 1680px
          // swim-lane to 0.21 zoom (unreadable) or, with minZoom
          // clamped, center the bbox so the first rows end up above
          // the viewport top. Instead, anchor top-left of the node
          // bbox at the top-left of the viewport at a readable zoom
          // â€” same logic as the "Center" preset button. User pans to
          // see the rest.
          if (!frameNodesFromTopLeft(reactFlow, displayNodes, {
            zoom: 0.85,
            duration: reduceMotion ? 0 : 300,
            paddingX: 16,
            paddingY: 112,
          })) {
            reactFlow.fitView({ padding: 0.1, duration: reduceMotion ? 0 : 300, minZoom: 0.6, maxZoom: 1.0 });
          }
        } else {
          reactFlow.fitView({
            padding: 0.2,
            duration: reduceMotion ? 0 : 300,
            minZoom: MIN_READABLE_ZOOM,
            maxZoom: 1.0,
          });
        }
        // The graph is now framed. Release the auto-follow gate so live
        // streaming can resume centering on new nodes, but only AFTER this
        // initial fit has run (prevents the cold-open off-screen camera).
        hasInitiallyFitRef.current = true;
        pendingFitViewRef.current = false; // consume only now that the fit committed
        mglog("initial fitView COMMITTED", { displayNodes: displayNodes.length, isCompact });
        setTimeout(() => { programmaticMoveRef.current = false; }, 350);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [compactViewer, displayNodes, reactFlow, reduceMotion]);

  const selectedLayoutNode = useMemo(
    () => layoutedDisplayNodes.find((node) => node.id === selectedNode) || null,
    [layoutedDisplayNodes, selectedNode]
  );

  const centerViewportOnNode = useCallback(
    (nodeId, options = {}) => {
      if (!nodeId) return undefined;

      const liveNode = reactFlow.getNode(nodeId);
      // Fall back to the CURRENTLY DISPLAYED tier's layout, not the
      // chunk-level `layoutedNodes`. A node shown at the arcs tier (yâ‰ˆ130)
      // also exists in the chunk dagre at yâ‰ˆ17000+; centering on that stale
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

  // Center on a node chosen from the TIMELINE RIBBON without opening the detail
  // drawer (which is bound to `selectedNode`). The ribbon "teleports" the camera
  // only; re-centering is keyed on focusNode CHANGING, so a later user pan isn't
  // yanked back when the layout updates.
  const lastFocusedRef = useRef(null);
  useEffect(() => {
    if (focusNode === lastFocusedRef.current) return undefined;
    lastFocusedRef.current = focusNode;
    if (!focusNode) return undefined;
    // user is driving now — stop auto-follow so it doesn't fight the jump
    if (autoFollowRef.current) {
      autoFollowRef.current = false;
      setAutoFollow(false);
    }
    let cleanup;
    const raf = requestAnimationFrame(() => {
      cleanup = centerViewportOnNode(focusNode, { zoom: 1.15, duration: reduceMotion ? 0 : 280 });
    });
    return () => {
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [focusNode, centerViewportOnNode, reduceMotion]);

  // Sync ref with state so effects read the latest value
  useEffect(() => {
    autoFollowRef.current = autoFollow && !selectedNode;
  }, [autoFollow, selectedNode]);

  // Keep the HUD truthful throughout user and programmatic camera motion.
  // React Flow does not reliably emit onMoveEnd for every fitView path.
  const handleMove = useCallback((_event, viewport) => {
    if (Number.isFinite(viewport?.zoom)) setZoomLevel(viewport.zoom);
  }, []);

  // Sync zoom level from ReactFlow viewport when motion settles.
  const handleMoveEnd = useCallback((_event, viewport) => {
    handleMove(_event, viewport);
    if (programmaticMoveRef.current) return;
    userOverrodeTierRef.current = true; // genuine user pan/zoom â€” they're driving now
    if (autoFollowRef.current) {
      autoFollowRef.current = false;
      setAutoFollow(false);
    }
  }, [handleMove]);

  // Also sync on mount â€” fitView doesn't fire onMoveEnd
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
    mglog("auto-pan attempt", { autoFollow, selectedNode, hasInitiallyFit: hasInitiallyFitRef.current, lastNodeId, lastY: layoutedDisplayNodes[layoutedDisplayNodes.length - 1]?.position?.y });
    if (!autoFollow || selectedNode || layoutedDisplayNodes.length === 0) return;
    // Cold-open guard: autoFollow defaults true, so without this the mount
    // auto-pan fires before the initial fitView and parks the camera ~17000px
    // off-screen (empty canvas until "Center"). Every tier/drill handler
    // already clears auto-follow for this reason; this covers the one path
    // they missed â€” the very first load.
    if (!hasInitiallyFitRef.current) return;
    const last = layoutedDisplayNodes[layoutedDisplayNodes.length - 1];
    if (!last?.id) return;

    // Temporarily mark as programmatic so onMoveEnd doesn't disable follow
    const wasProgrammatic = programmaticMoveRef.current;
    const cleanup = centerViewportOnNode(last.id, {
      zoom: 1,
      duration: reduceMotion ? 0 : 400,
    });

    return () => {
      cleanup?.();
      programmaticMoveRef.current = wasProgrammatic;
    };
  }, [autoFollow, centerViewportOnNode, lastNodeId, layoutedDisplayNodes, reduceMotion, selectedNode]);

  // Center selected node when chosen from timeline or graph.
  useEffect(() => {
    mglog("center-on-selected (ribbon/click)", { selectedNode, hasLayoutNode: !!selectedLayoutNode, pos: selectedLayoutNode?.position });
    if (!selectedNode || !selectedLayoutNode?.position) return undefined;

    let cleanup;
    const raf = requestAnimationFrame(() => {
      cleanup = centerViewportOnNode(selectedNode, {
        zoom: 1.15,
        duration: reduceMotion ? 0 : 280,
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [centerViewportOnNode, reduceMotion, selectedLayoutNode, selectedNode, viewportReservationKey]);

  // Cluster detail panel state
  const [selectedCluster, setSelectedCluster] = useState(null);

  const handleNodeClick = useCallback(
    (_, node) => {
      // Cluster nodes keep their single-click panel toggle.
      if (node.data?.memberCount != null) {
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
      // Debounce: a fast accidental double-click fires two click events; ignore
      // the second so a single tap can't drill twice (or into the just-changed
      // view). zoomOnDoubleClick is also disabled on ReactFlow.
      if (Date.now() - lastDrillAtRef.current < 350) return;
      setSelectedCluster(null);
      setClickedEdge(null);
      // SINGLE TAP (Option A) = expand if the node has children; a leaf opens
      // its drawer (nothing to expand). Drag is still press-and-move; the
      // drawer for a node WITH children is its "details" chip.
      const fd = node.data?.fullData || {};
      const childIds = Array.isArray(fd.children_ids) ? fd.children_ids : [];
      const ownLevel = Number(fd.semantic_level || fd.level || 1);
      if (childIds.length > 0 && ownLevel > 1) {
        lastDrillAtRef.current = Date.now();
        handleExpand(node.id);
      } else {
        handleOpenDetails(node.id);
      }
    },
    [handleExpand, handleOpenDetails, setSelectedNode]
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
    { label: "Center", hint: "Return to a readable overview", action: () => {
      // Keep a readable zoom and anchor the camera so the TOP-LEFT
      // of the node bounding box lines up with the top-left of the viewport
      // (with a small padding). fitView's previous behavior recomputed zoom
      // AND centered on the bbox centroid â€” on tall wrapped layouts (147
      // ideas in a swim-lane) the centroid was visually empty between
      // column groups, putting the camera in negative space.
      const nodes = displayNodes;
      if (!nodes || nodes.length === 0) {
        reactFlow.fitView({ padding: 0.3, duration: reduceMotion ? 0 : 300, minZoom: MIN_READABLE_ZOOM });
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
        reactFlow.fitView({ padding: 0.3, duration: reduceMotion ? 0 : 300, minZoom: MIN_READABLE_ZOOM });
        return;
      }
      const currentZoom = reactFlow.getZoom?.() ?? 1;
      const readableZoom = Math.max(currentZoom, MIN_READABLE_ZOOM);
      const PADDING_PX = 40;
      programmaticMoveRef.current = true;
      reactFlow.setViewport(
        {
          x: -minX * readableZoom + PADDING_PX,
          y: -minY * readableZoom + PADDING_PX,
          zoom: readableZoom,
        },
        { duration: reduceMotion ? 0 : 300 },
      );
      setTimeout(() => { programmaticMoveRef.current = false; }, reduceMotion ? 0 : 350);
    }},
  ];

  return (
    <div className={`relative w-full h-full${chromeless ? " lct-graph-chromeless" : ""}`}>
      {/* Weakness lenses — one-click "where is the argument weak" filters.
          Dim everything except the matching claims (+ their ancestors so
          coarser tiers stay meaningful). Hidden during argument trace. */}
      {!argumentTraceFrom && (
        <div className="absolute bottom-14 left-2 right-2 z-40 flex items-center gap-1 overflow-x-auto pb-1 sm:bottom-12 sm:left-3 sm:right-auto sm:flex-wrap sm:overflow-visible sm:pb-0">
          {[
            { key: "unsupported", label: "unsupported", title: "Claims with no incoming support/evidence" },
            { key: "uncontested", label: "uncontested", title: "Claims nobody pushed back on" },
            { key: "battleground", label: "battlegrounds", title: "Claims both supported and rebutted" },
            { key: "questions", label: "open questions", title: "Questions raised in the conversation" },
            { key: "contradictions", label: "self-contradictions", title: "Statements in tension with the same speaker's other statements" },
          ]
            .filter((c) => weaknessSets.counts[c.key] > 0)
            .map((c) => {
              const active = weaknessFilter === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  title={c.title}
                  onClick={() => setWeaknessFilter(active ? null : c.key)}
                  className={`min-h-11 shrink-0 rounded-full border px-3 py-1 text-[10px] font-medium shadow-sm transition-colors sm:min-h-0 sm:px-2 sm:py-0.5 ${
                    active
                      ? "border-amber-400 bg-amber-100 text-amber-900"
                      : "border-gray-200 bg-white/90 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {c.label} {weaknessSets.counts[c.key]}
                  {active ? " ×" : ""}
                </button>
              );
            })}
        </div>
      )}
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
        onPaneClick={handlePaneClick}
        onEdgeClick={handleEdgeClick}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.data)}
        onEdgeMouseLeave={() => setHoveredEdge(null)}
        zoomOnPinch
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnDrag
        panOnScroll
        minZoom={0.3}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      />

      {/* Zoom preset + graph display controls. Center stays out front (the
          recovery action); the secondary view toggles collapse behind a
          "Display" disclosure so the resting canvas stays calm (ADR-011) â€” a
          first-time recipient sees Center + Display, not a six-control cockpit.
          Native <details> keeps it keyboard-accessible with no extra state. */}
      <div className="absolute bottom-2 left-2 z-40 flex items-center gap-2 sm:bottom-4 sm:left-4 sm:gap-1">
        {ZOOM_PRESETS.map(({ label, action, hint }) => (
          <button
            key={label}
            onClick={action}
            title={hint || label}
            className="min-h-11 rounded border border-gray-200 bg-white/90 px-3 py-1 text-[10px] font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 sm:min-h-0 sm:px-2"
          >
            {label}
          </button>
        ))}
        <details className="relative">
          <summary
            className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded border border-gray-200 bg-white/90 px-3 py-1 text-[10px] font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 sm:min-h-0 sm:px-2"
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
          <div className="absolute bottom-full left-0 mb-2 flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white/95 p-1.5 shadow-md animate-slideIn [&_button]:min-h-11 sm:[&_button]:min-h-0">
            <button
              onClick={() => {
                setAutoFollow((v) => {
                  const next = !v;
                  autoFollowRef.current = next;
                  if (next && layoutedNodes.length > 0) {
                    const last = layoutedNodes[layoutedNodes.length - 1];
                    if (last?.id) {
                      centerViewportOnNode(last.id, { zoom: 1, duration: reduceMotion ? 0 : 300 });
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
                X position of nodes already encodes time â€” rendering temporal
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
            <ModeLegend
              mode={colorMode}
              nodes={normalizedChunk}
              speakerColorMap={speakerColorMap}
              threadColorMap={threadColorMap}
            />
          </div>
        </details>
      </div>

      <MinimalGraphHud
        zoomLevel={zoomLevel}
        clusterLevelLabel={clusterLevelLabel}
        displayMode={displayMode}
        effectiveSemanticLevel={effectiveSemanticLevel}
        effectiveClusterLevel={effectiveClusterLevel}
        displayNodes={displayNodes}
        displayEdges={displayEdges}
        projectionStats={effectiveView?.projectionStats || null}
        normalizedChunk={normalizedChunk}
        lockedLevel={lockedLevel}
        drilldownPath={drilldownPath}
        setDrilldownPath={setDrilldownPath}
        legacyClusterLevel={legacyClusterLevel}
        autoFollowRef={autoFollowRef}
        setAutoFollow={setAutoFollow}
        userOverrodeTierRef={userOverrodeTierRef}
        setLockedLevel={setLockedLevel}
      />

      <MinimalGraphPanels
        hoveredEdge={hoveredEdge}
        clickedEdge={clickedEdge}
        setClickedEdge={setClickedEdge}
        selectedCluster={selectedCluster}
        selectedClusterMembers={selectedClusterMembers}
        setSelectedCluster={setSelectedCluster}
        setLockedLevel={setLockedLevel}
        setSelectedNode={setSelectedNode}
      />

    </div>
  );
}

MinimalGraphInner.propTypes = {
  graphData: PropTypes.array,
  semanticEdges: PropTypes.array,
  selectedNode: PropTypes.string,
  focusNode: PropTypes.string,
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
  semanticEdges: PropTypes.array,
  selectedNode: PropTypes.string,
  focusNode: PropTypes.string,
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
