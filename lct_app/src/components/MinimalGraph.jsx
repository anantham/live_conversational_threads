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

// --- Similarity layout (clusters a drilled subset by relatedness) ----------
// Stopwords + filler so the bag-of-words captures topical content, not glue.
const LAYOUT_STOPWORDS = new Set(
  ("the a an and or but of to in on for with as is are was were be been being it its this that these those you your "
    + "i we he she they them his her their our not no so if then than at by from about into over under can will would "
    + "just like really actually kind sort thing things stuff what which who when where how why do does did have has "
    + "had get got make made one two also more most much very some any all out up down here there now")
    .split(" ")
);

// Normalized term-frequency vector over a node's name + summary.
function layoutTextVec(node) {
  const fd = node.data?.fullData || {};
  const text = `${fd.node_name || node.data?.title || ""} ${fd.summary || node.data?.summary || ""}`.toLowerCase();
  const v = new Map();
  for (const tok of text.split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || LAYOUT_STOPWORDS.has(tok)) continue;
    v.set(tok, (v.get(tok) || 0) + 1);
  }
  let norm = 0;
  for (const c of v.values()) norm += c * c;
  norm = Math.sqrt(norm) || 1;
  for (const key of v.keys()) v.set(key, v.get(key) / norm);
  return v;
}

function layoutCosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [key, va] of small) {
    const vb = big.get(key);
    if (vb) s += va * vb;
  }
  return s;
}

// Similarity-seriated grid: keep the COMPACT grid (which fixed the zoom-out) but
// make its ORDER meaningful so related cards sit adjacent. A force layout was
// tried and rejected — it spread the subset WIDER than the grid and barely
// clustered (lexical similarity over short summaries is a weak signal, and
// repulsion just pushes everything apart). Instead: greedy nearest-neighbour
// seriation over (text cosine + edge bonus), snake-filled into the grid so
// consecutive (most-similar) nodes are spatially adjacent. Compact, clustered to
// the extent the lexical signal allows, deterministic, no spread regression.
// (Stronger semantic clustering would need real embeddings — an offline pass.)
function similarityLayout(nodes, edges, { nodeWidth = 480, nodeHeight = 360 } = {}) {
  const n = nodes.length;
  const gapX = nodeWidth + 90;
  const gapY = nodeHeight + 70;
  if (n <= 2) return nodes.map((nd, i) => ({ ...nd, position: { x: i * gapX, y: 0 } }));
  // Prefer the baked MiniLM embedding (real semantic signal) — bag-of-words over
  // short summaries was too weak/noisy to cluster. Embeds are L2-normalized, so
  // a dot product == cosine. Falls back to lexical cosine if embeds are absent.
  const embs = nodes.map((nd) => nd.data?.fullData?.embed);
  const useEmbed = embs.every((e) => Array.isArray(e) && e.length >= 4);
  const vecs = useEmbed ? null : nodes.map(layoutTextVec);
  const affPair = useEmbed
    ? (i, j) => {
        const a = embs[i];
        const b = embs[j];
        let s = 0;
        for (let t = 0; t < a.length; t++) s += a[t] * b[t];
        return s;
      }
    : (i, j) => layoutCosine(vecs[i], vecs[j]);
  const aff = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = affPair(i, j);
      aff[i][j] = s;
      aff[j][i] = s;
    }
  }
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  (edges || []).forEach((e) => {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a != null && b != null && a !== b) { aff[a][b] += 0.5; aff[b][a] += 0.5; }
  });
  // Start the chain at the most-central node (highest total affinity), then keep
  // appending the most-similar not-yet-placed node.
  let start = 0;
  let bestSum = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += aff[i][j];
    if (s > bestSum) { bestSum = s; start = i; }
  }
  const used = new Array(n).fill(false);
  const order = [start];
  used[start] = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let nxt = -1;
    let bs = -2;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      if (aff[last][j] > bs) { bs = aff[last][j]; nxt = j; }
    }
    if (nxt === -1) nxt = used.indexOf(false);
    order.push(nxt);
    used[nxt] = true;
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return order.map((nodeIdx, p) => {
    const row = Math.floor(p / cols);
    let col = p % cols;
    if (row % 2 === 1) col = cols - 1 - col; // snake so row-to-row stays adjacent
    return { ...nodes[nodeIdx], position: { x: col * gapX, y: row * gapY } };
  });
}

// Rectangle de-overlap: separate any cards whose centers are closer than a
// card-plus-margin in both axes. Used after the PCA projection (which only sets
// relative positions) so nothing ever visually collides.
function deOverlap(P, nodeWidth, nodeHeight, passes = 140) {
  const minDX = nodeWidth + 60;
  const minDY = nodeHeight + 50;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const dx = P[j].x - P[i].x;
        const dy = P[j].y - P[i].y;
        const ox = minDX - Math.abs(dx);
        const oy = minDY - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox <= oy) { const s = ((dx < 0 ? -1 : 1) * ox) / 2 || 0.5; P[i].x -= s; P[j].x += s; }
          else { const s = ((dy < 0 ? -1 : 1) * oy) / 2 || 0.5; P[i].y -= s; P[j].y += s; }
        }
      }
    }
    if (!moved) break;
  }
}

// Dominant eigenvector of a small symmetric matrix via power iteration
// (deterministic seed). Used for the top-2 principal components.
function topEigenvector(C, d) {
  let v = new Float64Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.cos(i + 1); // non-uniform, deterministic
  for (let it = 0; it < 80; it++) {
    const nv = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += C[i][j] * v[j];
      nv[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < d; i++) norm += nv[i] * nv[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < d; i++) v[i] = nv[i] / norm;
  }
  return v;
}

// Semantic 2-D map of a drilled subset: project each node's baked MiniLM
// embedding onto the subset's top-2 principal components, so genuinely-related
// children land near each other (true 2-D clustering, not a 1-D seriation), then
// de-overlap for spacing. Returns null if embeddings are absent (fallback).
function embedLayout(nodes, { nodeWidth = 480, nodeHeight = 360 } = {}) {
  const n = nodes.length;
  const embs = nodes.map((nd) => nd.data?.fullData?.embed);
  if (n <= 2 || embs.some((e) => !Array.isArray(e) || e.length < 4)) return null;
  const d = embs[0].length;
  const mean = new Float64Array(d);
  for (const e of embs) for (let i = 0; i < d; i++) mean[i] += e[i];
  for (let i = 0; i < d; i++) mean[i] /= n;
  const X = embs.map((e) => { const r = new Float64Array(d); for (let i = 0; i < d; i++) r[i] = e[i] - mean[i]; return r; });
  const C = Array.from({ length: d }, () => new Float64Array(d));
  for (const r of X) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += r[i] * r[j];
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= n;
  const v1 = topEigenvector(C, d);
  let lam1 = 0;
  for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += C[i][j] * v1[j]; lam1 += v1[i] * s; }
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] -= lam1 * v1[i] * v1[j]; // deflate
  const v2 = topEigenvector(C, d);
  const coords = X.map((r) => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < d; i++) { a += r[i] * v1[i]; b += r[i] * v2[i]; }
    return { x: a, y: b };
  });
  // Scale the projection so ~±2 std fills the grid footprint, then de-overlap.
  let mx2 = 0;
  let my2 = 0;
  coords.forEach((c) => { mx2 += c.x * c.x; my2 += c.y * c.y; });
  const rmsX = Math.sqrt(mx2 / n) || 1;
  const rmsY = Math.sqrt(my2 / n) || 1;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const fx = (cols * (nodeWidth + 90)) / (4 * rmsX);
  const fy = (rows * (nodeHeight + 70)) / (4 * rmsY);
  const P = coords.map((c) => ({ x: c.x * fx, y: c.y * fy }));
  deOverlap(P, nodeWidth, nodeHeight);
  let minX = Infinity;
  let minY = Infinity;
  P.forEach((p) => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; });
  return nodes.map((nd, i) => ({ ...nd, position: { x: Math.round(P[i].x - minX), y: Math.round(P[i].y - minY) } }));
}

// Re-pack a drilled subset. Drilling FILTERS the global (timestamp-driven) tier
// layout, so a parent's children keep their global X/Y and stay scattered across
// the whole-corpus canvas — children can come from different times AND different
// conversations, so they land thousands of px apart, forcing a zoom-out. Pull
// them into a fresh LOCAL layout near the origin:
//   - edge-dense subset    -> Dagre flow (arranged by its argument edges)
//   - else, with embeds    -> PCA-2D semantic map (clusters related children)
//   - else (no embeds)     -> similarity-seriated grid (lexical fallback)
//   - very large           -> compact grid (projection would be cluttered)
function repackSubset(nodes, edges) {
  if (!nodes || nodes.length <= 1) return nodes;
  const NW = 480;
  const NH = 360;
  if (edges && edges.length >= Math.ceil(nodes.length * 0.6)) {
    return layoutWithDagre(nodes.map((n) => ({ ...n })), edges, { nodeWidth: NW, nodeHeight: NH });
  }
  if (nodes.length <= 80) {
    return embedLayout(nodes, { nodeWidth: NW, nodeHeight: NH })
      || similarityLayout(nodes, edges, { nodeWidth: NW, nodeHeight: NH });
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const gapX = NW + 90;
  const gapY = NH + 70;
  return nodes.map((n, i) => ({
    ...n,
    position: { x: (i % cols) * gapX, y: Math.floor(i / cols) * gapY },
  }));
}

// Floor on auto-fit zoom — below this card text gets unreadable. The user
// can still mouse-wheel zoom out past it for a macro overview; this only
// caps the auto-fit behaviour on tier change / drilldown / center reset.
const MIN_READABLE_ZOOM = 0.65;

// Diagnostic logging for the cold-open "blank until interaction" investigation
// (camera-framing race: nodes render fine, but the initial fitView is
// skipped/mistimed so the viewport sits off-screen at the tall chunk dagre's
// y; any interaction issues a fresh camera command that brings it back).
// Root cause was found + fixed (synchronous landing tier + late fit-consume),
// so these are OFF by default now. Re-enable any time in the console with
// window.__MG_DEBUG__ = true (then reload) to watch the view/camera state flow.
let MG_DEBUG = false;
const mglog = (...a) => {
  if (MG_DEBUG || (typeof window !== "undefined" && window.__MG_DEBUG__)) {
    console.log("[MG]", ...a);
  }
};


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
  // True once the USER has explicitly chosen a tier or driven the camera
  // (locked/unlocked a tier, or manually zoomed/panned). Until then we force
  // the synchronously-computed landing tier so a cold open can never fall
  // through to the zoom=1 -> finest mapping (which builds the tall chunk
  // layout and strands the camera). Survives remounts correctly: a fresh
  // instance starts false, so it re-forces the landing tier instead of the
  // finest one. See requestedSemanticLevel + initialLandingLevel.
  const userOverrodeTierRef = useRef(false);
  // Timestamp of the last drill — debounces an accidental double-click so a
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
  mglog("normalizedChunk", { allNodes: allNodes.length, normalized: normalizedChunk.length, graphDataLen: (graphData || []).length });

  // Default landing tier: the TOPMOST populated tier so the canvas opens on
  // the macro view (1-5 arcs / themes), not 100+ chunks. User can step down
  // via the tier-lock UI or by clicking into nodes. Earlier heuristic
  // demanded >=2.5x compression vs the next tier, but on conversations
  // where the LLM produces equal counts at L4 and L5 (no genuine
  // compression — 772ac0cc: 4 themes -> 4 arcs) it landed at L2, which
  // defeats the point. Pick the highest tier with content; if that tier
  // only has 1 node and a finer tier exists, drop down to the finer one.
  //
  // COLD-OPEN CAMERA FIX: this is computed SYNCHRONOUSLY (useMemo) and used as
  // the initial requestedSemanticLevel fallback below — so render 0 already
  // lays out the macro tier (e.g. 3 arcs) instead of the finest tier (e.g.
  // 2190 chunks, ~719000px tall). Previously the finest layout rendered on
  // render 0, a fitView parked the camera at its center (~y 359000), and the
  // post-paint tier flip's fit got cancelled before committing — leaving the
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
    // that tier has only 1 node and a finer tier exists with more — in
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
  // this no longer causes a node-set flip — it just lights up the lock chip.
  useEffect(() => {
    if (initialLockedAppliedRef.current) return;
    if (initialLandingLevel == null) return;
    mglog("auto-landing setLockedLevel", { chosen: initialLandingLevel });
    setLockedLevel(initialLandingLevel);
    initialLockedAppliedRef.current = true;
  }, [initialLandingLevel]);

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

  // Escape pops one drill level (mirrors the ← Back button). Gated on no active
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
          // Option A: a small "details" chip on nodes that have children opens
          // the drawer (their card-tap expands instead of opening it).
          onOpenDetails: () => handleOpenDetails(item.id),
          // Rhetoric layer (Phase 2): argumentative role + verified flags drive
          // the card chips + the Rhetoric color lens.
          claimType: item.claim_type || null,
          rhetoricFlags: Array.isArray(item.rhetoric_flags) ? item.rhetoric_flags : [],
          argStatusLabel,
          // fullData kept for downstream consumers (NodeDetail panel etc.)
          fullData: item,
        },
      };
    });
  }, [colorMode, speakerColorMap, temporalColorMap, argumentStatusMap, dateColorMap, handleExpand, handleOpenDetails]);

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
                // ConversationNode caps at 460w; the full LLM summary now
                // renders (no truncation), pushing card heights to ~330-360.
                // Layout must reserve that footprint or rows overlap.
                nodeWidth: 480,
                nodeHeight: 360,
                // ADR-032 Part A: X=timestamp_start, Y=thread row.
                // Falls back to column-index automatically when too few
                // nodes have timestamps (legacy / unrecorded conversations).
                timeBased: true,
                pixelsPerSecond,
                minNodeWidth: spec.level >= 3 ? 440 : 320,
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
      nodes: repackSubset(filteredNodes, filteredEdges),
      edges: filteredEdges,
    };
  }, [drilldownPath, normalizedChunk, authoredViews]);

  // Scoped tier view: when the user has drilled into a node and then taps a
  // DEEPER tier (e.g. "moments"/"ideas" while inside a theme), show only that
  // node's descendants at the chosen level — not the whole global tier. This is
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
    mglog("tier-change fit", { tierKey, drillKey, prev: lastFittedSemanticLevelRef.current, willFit: lastFittedSemanticLevelRef.current !== key });
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
      mglog("layout re-key -> arm fitView", { count: layoutedDisplayNodes.length, key: key.slice(0, 60), prevKey: layoutKeyRef.current.slice(0, 60) });
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
    mglog("fitView gate", { willRun: pendingFitViewRef.current && displayNodes.length > 0, pending: pendingFitViewRef.current, displayNodes: displayNodes.length, hasInitiallyFit: hasInitiallyFitRef.current });
    if (!pendingFitViewRef.current || displayNodes.length === 0) return;
    // NB: do NOT consume pendingFitViewRef here. If the node set changes again
    // before the rAFs fire (e.g. a tier flip on cold open), this effect's
    // cleanup cancels them — consuming early would lose the fit entirely and
    // strand the camera. We consume only after the fit actually commits.
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
        pendingFitViewRef.current = false; // consume only now that the fit committed
        mglog("initial fitView COMMITTED", { displayNodes: displayNodes.length, isNarrow });
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
    userOverrodeTierRef.current = true; // genuine user pan/zoom — they're driving now
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
    mglog("auto-pan attempt", { autoFollow, selectedNode, hasInitiallyFit: hasInitiallyFitRef.current, lastNodeId, lastY: layoutedDisplayNodes[layoutedDisplayNodes.length - 1]?.position?.y });
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
    mglog("center-on-selected (ribbon/click)", { selectedNode, hasLayoutNode: !!selectedLayoutNode, pos: selectedLayoutNode?.position });
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
    [handleExpand, handleOpenDetails]
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
        onPaneClick={handlePaneClick}
        onEdgeClick={handleEdgeClick}
        onMoveEnd={handleMoveEnd}
        onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.data)}
        onEdgeMouseLeave={() => setHoveredEdge(null)}
        fitView
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
          <div className="absolute bottom-full left-0 mb-2 flex flex-wrap items-center gap-1 bg-white/95 rounded-lg shadow-md border border-gray-200 p-1.5 max-w-[calc(100vw-2rem)] animate-slideIn">
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
        <div className="flex-shrink-0 flex items-center gap-1.5 rounded-md bg-white/95 border border-gray-200 shadow-sm px-2.5 py-1.5">
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
          <div className="flex-shrink-0 flex items-center gap-1.5 text-[11px] text-gray-600 bg-white/95 border border-gray-200 shadow-sm rounded-md px-2 py-1">
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-gray-100 border border-gray-300 px-2 py-0.5 font-semibold text-gray-700 hover:bg-gray-200 hover:text-gray-900 cursor-pointer"
              onClick={() => {
                autoFollowRef.current = false;
                setDrilldownPath((prev) => prev.slice(0, -1));
              }}
              title="Back up one level (Esc)"
            >
              <span aria-hidden="true">←</span> Back
            </button>
            <button
              type="button"
              className="text-blue-600 hover:underline font-medium cursor-pointer"
              onClick={() => {
                autoFollowRef.current = false;
                setDrilldownPath([]);
              }}
              title="Jump back to the top tier"
            >
              {AUTHORED_LEVELS.find((spec) => spec.level === (lockedLevel ?? drilldownPath[0]?.level))?.label || "top"}
            </button>
            {drilldownPath.map((crumb, idx) => (
              <span key={`${crumb.nodeId}-${idx}`} className="flex items-center gap-1">
                <span className="text-gray-500">/</span>
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
        <div className="flex-shrink-0 flex items-center gap-0 rounded-md bg-white/95 border border-gray-200 shadow-sm overflow-hidden">
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
                  userOverrodeTierRef.current = true; // user picked a tier — stop forcing the landing tier
                  mglog("tier button click", { clickedLevel: level, label, prevLockedLevel: lockedLevel, displayMode, willUnlock: lockedLevel === level, drillDepth: drilldownPath.length });
                  // Going DEEPER while drilled into a node = scope the tier to
                  // that node's subtree (keep the drill so scopedTierView filters
                  // to its descendants). Otherwise (no drill, or same/higher
                  // tier) switch to the full global tier.
                  const tailLevel = drilldownPath.length
                    ? drilldownPath[drilldownPath.length - 1].level
                    : null;
                  if (!(tailLevel != null && level < tailLevel)) {
                    setDrilldownPath([]);
                  }
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
                    : "text-gray-500 hover:text-gray-600 hover:bg-gray-50"
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
            className="text-[9px] text-gray-500 hover:text-gray-600 ml-1"
            title="Unlock zoom level"
          >
            unlock
          </button>
        )}
      </div>

      {/* Edge hover tooltip — transient, top-right */}
      {hoveredEdge && !clickedEdge && (
        <div className="absolute top-4 right-4 z-30 max-w-xs rounded-md bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-sm border border-gray-200 pointer-events-none">
          <span className="font-medium capitalize">{hoveredEdge.relationType}</span>
          {hoveredEdge.relationText && (
            <p className="mt-0.5 text-gray-500 line-clamp-2">{hoveredEdge.relationText}</p>
          )}
          <p className="mt-1 text-[10px] text-gray-500">click to pin</p>
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
              className="text-gray-500 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {(clickedEdge.sourceLabel || clickedEdge.targetLabel) && (
            <p className="text-[10px] text-gray-500 mb-2 truncate">
              {clickedEdge.sourceLabel}
              <span className="mx-1">→</span>
              {clickedEdge.targetLabel}
            </p>
          )}
          {clickedEdge.relationText ? (
            <p className="leading-relaxed text-gray-600">{clickedEdge.relationText}</p>
          ) : (
            <p className="text-gray-500 italic">No relation detail available.</p>
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
              <span className="text-[10px] text-gray-500 mt-0.5 block">
                {selectedClusterMembers.length} nodes in this cluster
              </span>
            </div>
            <button
              onClick={() => setSelectedCluster(null)}
              className="text-gray-500 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
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
                  <p className="text-[10px] text-gray-500 mt-0.5 ml-6 line-clamp-2">{node.source_excerpt}</p>
                )}
                {node.summary && !node.source_excerpt && (
                  <p className="text-[10px] text-gray-500 mt-0.5 ml-6 line-clamp-2">{node.summary}</p>
                )}
                <div className="flex gap-2 mt-1 ml-6">
                  {(node.speaker_display || node.speaker_id) && (
                    <span className="text-[9px] text-gray-500">speaker: {node.speaker_display || node.speaker_id}</span>
                  )}
                  {node.edge_relations?.length > 0 && (
                    <span className="text-[9px] text-gray-500">{node.edge_relations.length} edges</span>
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
        <div className="absolute bottom-4 left-40 z-40">
          <details className="group">
            <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2.5 py-1.5 bg-white/85 hover:bg-white/95 rounded-full shadow-sm border border-gray-200 text-gray-500 hover:text-gray-700 transition opacity-80 hover:opacity-100 text-[10px] font-medium">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Colors
            </summary>
            <div className="absolute bottom-full left-0 mb-2 bg-white/95 rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-2 min-w-[180px] animate-slideIn">
              {displayMode === "semantic" ? (
                <>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Current semantic level</span>
                    <div className="mt-1 text-[11px] text-gray-600">
                      {AUTHORED_LEVELS.find((spec) => spec.level === effectiveSemanticLevel)?.label || "authored"}
                    </div>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      This view is using backend-authored hierarchy, not frontend clustering.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Speaker / temporal palette</span>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      Speaker colors appear when multiple speakers are detected. Otherwise colors fade by temporal position.
                    </div>
                  </div>
                </>
              ) : effectiveClusterLevel === 0 ? (
                <>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Speaker</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(speakerColorMap).slice(0, 5).map(([sid, color]) => (
                        <div key={sid} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full border border-gray-300" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{sid}</span>
                        </div>
                      ))}
                      {Object.keys(speakerColorMap).length === 0 && (
                        <span className="text-gray-500 italic">No speakers detected</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Edge color = Relation</span>
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
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Wavelength Rainbow</span>
                    <div className="mt-2 flex flex-col gap-1">
                      <div 
                        className="h-2 w-full rounded-full" 
                        style={{ background: 'linear-gradient(to right, hsl(0, 75%, 88%), hsl(140, 75%, 88%), hsl(280, 75%, 88%))' }}
                      />
                      <div className="flex justify-between text-[9px] text-gray-500 font-mono uppercase tracking-tight">
                        <span>Start</span>
                        <span>Now</span>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-gray-500 leading-tight">
                      Nodes stretch across the spectrum as the conversation grows. Labels update to speaker colors after ~2 mins.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Edge color = Agreement</span>
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
                  <div className="text-[10px] text-gray-500">
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
