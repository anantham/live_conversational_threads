# Minimal Live Conversation UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the cluttered NewConversation page with a minimal, ambient UI designed for real-time use during live conversations — glanceable at lulls, invisible during flow.

**Architecture:** New page shell (`NewConversation.jsx` rewrite) with three zones: edge-to-edge ReactFlow graph (main), plain-DOM timeline ribbon (bottom strip), and compact audio footer. Node interaction via slide-in detail panel. Auto-save in background. Responsive for phone/tablet via Tailscale.

**Tech Stack:** React 18, ReactFlow 11, dagre, Tailwind CSS 4, Inter font, Lucide icons. Existing WebSocket audio pipeline unchanged.

**ADR:** `docs/adr/ADR-011-minimal-live-conversation-ui.md`

**Branch:** `feat/minimal-live-ui`

---

## Phase 1: Setup & Strip (remove dead code)

### Task 1: Create branch and install Inter font

**Files:**
- Modify: `lct_app/package.json`
- Modify: `lct_app/src/index.css`

**Step 1: Create feature branch from main**

```bash
# Stash any uncommitted work on current branch
git stash
git checkout main
git pull origin main
git checkout -b feat/minimal-live-ui
```

**Note:** We branch from `main`, not from `debt/split-thematic-view` which has unrelated work.

**Step 2: Install Inter font**

```bash
cd lct_app && npm install @fontsource/inter
```

**Step 3: Import Inter in index.css**

Add to `lct_app/src/index.css` (before the tailwind import):

```css
@import "@fontsource/inter/latin-400.css";
@import "@fontsource/inter/latin-500.css";
@import "@fontsource/inter/latin-600.css";
@import "tailwindcss";

@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
}
```

**Step 4: Verify the app still builds**

```bash
cd lct_app && npm run dev
```

Open http://localhost:5173 — confirm the app loads. Font should change to Inter.

**Step 5: Commit**

```bash
git add lct_app/package.json lct_app/package-lock.json lct_app/src/index.css
git commit -m "feat(ui): install Inter font and configure as default sans-serif"
```

---

### Task 2: Strip dead imports and formalism code from NewConversation

**Files:**
- Modify: `lct_app/src/pages/NewConversation.jsx`

**Context:** We are rewriting this file entirely in Task 5, but first we strip it so that the app continues to work while we build new components in parallel. This task removes formalism, save buttons, and other features ADR-011 eliminates.

**Step 1: Replace NewConversation.jsx with stripped version**

Replace the entire file content with:

```jsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import ContextualGraph from "../components/ContextualGraph";

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [conversationId] = useState(() => crypto.randomUUID());

  const handleDataReceived = (newData) => setGraphData(newData);
  const handleChunksReceived = (chunks) => setChunkDict(chunks);

  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-screen w-screen bg-[#fafafa]">
      {/* Minimal header — just back button */}
      <div className="absolute top-4 left-4 z-10">
        <button
          onClick={() => navigate("/")}
          className="p-2 text-gray-400 hover:text-gray-600 transition"
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Graph area */}
      <div className="flex-grow">
        <ContextualGraph
          graphData={graphData}
          chunkDict={chunkDict}
          setGraphData={setGraphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          isFullScreen={isFullScreen}
          setIsFullScreen={setIsFullScreen}
        />
      </div>

      {/* Audio footer */}
      <div className="w-full p-3 flex justify-center">
        <AudioInput
          onDataReceived={handleDataReceived}
          onChunksReceived={handleChunksReceived}
          chunkDict={chunkDict}
          graphData={graphData}
          conversationId={conversationId}
          setConversationId={setConversationId}
          setMessage={setMessage}
          message={message}
          fileName={fileName}
          setFileName={setFileName}
        />
      </div>
    </div>
  );
}
```

**Step 2: Verify app loads at /new**

```bash
cd lct_app && npm run dev
```

Open http://localhost:5173/new — confirm it renders with warm gray background, no gradient, no formalism buttons, no save buttons.

**Step 3: Commit**

```bash
git add lct_app/src/pages/NewConversation.jsx
git commit -m "refactor(ui): strip formalism, save buttons, gradient from NewConversation

MOTIVATION: ADR-011 requires minimal UI. Remove GenerateFormalism, FormalismList,
SaveJson, SaveTranscript, Legend, StructuralGraph, and blue-purple gradient.

CHANGES:
- NewConversation.jsx: stripped to bare minimum (graph + audio + back button)
- Background changed from gradient to #fafafa
- Removed all formalism state variables
- Removed StructuralGraph import and rendering"
```

---

## Phase 2: New Minimal Graph Component

### Task 3: Create MinimalGraph component shell

**Files:**
- Create: `lct_app/src/components/MinimalGraph.jsx`

**Context:** This replaces the 805-LOC ContextualGraph with a clean, minimal version. No claims panel, no fact-checking, no context sidebar, no transcript overlay, no fullscreen, no debug logging. Just ReactFlow + dagre + clean node/edge styling.

**Step 1: Create MinimalGraph.jsx**

```jsx
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ReactFlow, { useReactFlow, ReactFlowProvider } from "reactflow";
import dagre from "dagre";
import "reactflow/dist/style.css";

const NODE_TYPES = {};
const EDGE_TYPES = {};

const EDGE_COLORS = {
  supports: "#16a34a",
  rebuts: "#dc2626",
  clarifies: "#2563eb",
  asks: "#0f766e",
  tangent: "#d97706",
  return_to_thread: "#0284c7",
  contextual: "#9ca3af",
  temporal_next: "#d1d5db",
};

// Muted speaker palette — enough contrast to distinguish, not enough to scream
const SPEAKER_COLORS = [
  "#94a3b8", // slate-400
  "#7dd3fc", // sky-300
  "#fda4af", // rose-300
  "#a5b4fc", // indigo-300
  "#86efac", // green-300
  "#fcd34d", // amber-300
  "#c4b5fd", // violet-300
  "#67e8f9", // cyan-300
];

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
  onNodeHover,
}) {
  const reactFlow = useReactFlow();
  const autoFollowRef = useRef(true);
  const latestChunk = graphData?.[graphData.length - 1] || [];

  // Build speaker color map
  const speakerColorMap = useMemo(() => {
    const speakers = [
      ...new Set(latestChunk.map((n) => n.speaker_id).filter(Boolean)),
    ];
    const map = {};
    speakers.forEach((s, i) => {
      map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    });
    return map;
  }, [latestChunk]);

  // Build ReactFlow nodes
  const rfNodes = useMemo(() => {
    return latestChunk.map((item) => {
      const isSelected = selectedNode === item.id;
      const speakerColor = speakerColorMap[item.speaker_id] || "#e2e8f0";
      // 2-3 anchor words from node_name
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
  }, [latestChunk, selectedNode, speakerColorMap]);

  // Build ReactFlow edges
  const rfEdges = useMemo(() => {
    const edges = [];

    latestChunk.forEach((item) => {
      // Temporal edges
      if (item.successor) {
        const target = latestChunk.find((n) => n.id === item.successor);
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
        const related = latestChunk.find((n) => n.node_name === rel?.related_node);
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

      // Fallback: contextual_relation map (backward compat)
      if (relations.length === 0 && item.contextual_relation) {
        Object.entries(item.contextual_relation).forEach(([relName, relText]) => {
          const related = latestChunk.find((n) => n.node_name === relName);
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
  }, [latestChunk, selectedNode]);

  // Layout
  const layoutedNodes = useMemo(
    () => layoutWithDagre(rfNodes, rfEdges),
    [rfNodes, rfEdges]
  );

  // Auto-pan to latest nodes
  useEffect(() => {
    if (!autoFollowRef.current || layoutedNodes.length === 0) return;
    const last = layoutedNodes[layoutedNodes.length - 1];
    if (last?.position) {
      reactFlow.setCenter(last.position.x, last.position.y, {
        zoom: 1,
        duration: 400,
      });
    }
  }, [layoutedNodes.length, reactFlow]);

  // Stop auto-follow on manual interaction
  const handleMoveStart = useCallback((_, viewport) => {
    // User initiated a pan/zoom — pause auto-follow
  }, []);

  const handleMoveEnd = useCallback(() => {
    // Could set autoFollowRef.current = false here
    // For MVP, we keep auto-follow always on
  }, []);

  const handleNodeClick = useCallback(
    (_, node) => {
      setSelectedNode((prev) => (prev === node.id ? null : node.id));
    },
    [setSelectedNode]
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // Edge hover tooltip
  const [hoveredEdge, setHoveredEdge] = useState(null);

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
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        fitView
        zoomOnPinch
        zoomOnScroll
        panOnDrag
        panOnScroll={false}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      />

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

// useState is included in the import line at the top of this file.

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
  onNodeHover: PropTypes.func,
};
```

**Step 2: Verify it renders**

Temporarily swap it into NewConversation.jsx (replace ContextualGraph import with MinimalGraph). Confirm nodes would render with the right styling when data arrives.

**Step 3: Commit**

```bash
git add lct_app/src/components/MinimalGraph.jsx
git commit -m "feat(ui): create MinimalGraph component for ADR-011

Clean ReactFlow + dagre graph with:
- Pill-shaped nodes with speaker colors and anchor words
- Typed edge colors (supports/rebuts/clarifies/tangent)
- Auto-pan to follow latest nodes
- Edge hover tooltip
- No Background dots, no Controls chrome, no attribution
- ~200 LOC vs 805 LOC ContextualGraph"
```

---

### Task 4: Create TimelineRibbon component

**Files:**
- Create: `lct_app/src/components/TimelineRibbon.jsx`

**Context:** A thin horizontal strip at the bottom. Each node is a small colored dot (speaker color) positioned along a time axis. Plain DOM, no ReactFlow. Clicking a dot selects the corresponding node in the graph.

**Step 1: Create TimelineRibbon.jsx**

```jsx
import { useRef, useEffect, useMemo } from "react";
import PropTypes from "prop-types";

const SPEAKER_COLORS = [
  "#94a3b8", "#7dd3fc", "#fda4af", "#a5b4fc",
  "#86efac", "#fcd34d", "#c4b5fd", "#67e8f9",
];

export default function TimelineRibbon({
  graphData,
  selectedNode,
  setSelectedNode,
}) {
  const scrollRef = useRef(null);
  const latestChunk = graphData?.[graphData.length - 1] || [];

  // Speaker color map
  const speakerColorMap = useMemo(() => {
    const speakers = [...new Set(latestChunk.map((n) => n.speaker_id).filter(Boolean))];
    const map = {};
    speakers.forEach((s, i) => {
      map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    });
    return map;
  }, [latestChunk]);

  // Auto-scroll to end when new nodes arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [latestChunk.length]);

  if (latestChunk.length === 0) return null;

  const dotSpacing = 36; // px between dots
  const totalWidth = latestChunk.length * dotSpacing + 40; // padding

  return (
    <div
      ref={scrollRef}
      className="w-full h-10 overflow-x-auto overflow-y-hidden border-t border-gray-200 bg-white/80 backdrop-blur-sm"
      style={{ scrollBehavior: "smooth" }}
    >
      <div
        className="relative h-full flex items-center"
        style={{ width: `${totalWidth}px`, minWidth: "100%" }}
      >
        {/* Connecting line */}
        <div
          className="absolute top-1/2 left-5 h-px bg-gray-200"
          style={{ width: `${(latestChunk.length - 1) * dotSpacing}px` }}
        />

        {/* Dots */}
        {latestChunk.map((node, i) => {
          const isSelected = selectedNode === node.id;
          const color = speakerColorMap[node.speaker_id] || "#e2e8f0";

          return (
            <button
              key={node.id}
              onClick={() =>
                setSelectedNode((prev) => (prev === node.id ? null : node.id))
              }
              className="absolute flex items-center justify-center transition-all duration-200"
              style={{
                left: `${20 + i * dotSpacing}px`,
                top: "50%",
                transform: `translateY(-50%) scale(${isSelected ? 1.4 : 1})`,
              }}
              title={node.node_name || `Node ${i + 1}`}
              aria-label={node.node_name || `Node ${i + 1}`}
            >
              <div
                className="rounded-full transition-all duration-200"
                style={{
                  width: isSelected ? "12px" : "8px",
                  height: isSelected ? "12px" : "8px",
                  backgroundColor: color,
                  border: isSelected ? "2px solid #f59e0b" : "1px solid #cbd5e1",
                  boxShadow: isSelected
                    ? "0 0 0 3px rgba(245,158,11,0.25)"
                    : "none",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

TimelineRibbon.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
};
```

**Step 2: Commit**

```bash
git add lct_app/src/components/TimelineRibbon.jsx
git commit -m "feat(ui): create TimelineRibbon plain-DOM component

Thin horizontal strip (~40px) with:
- Colored dots per node (speaker color)
- Connecting line between dots
- Click to select (syncs with graph)
- Auto-scrolls to latest node
- No ReactFlow, no dagre — pure DOM positioning"
```

---

### Task 5: Create NodeDetail slide-in panel

**Files:**
- Create: `lct_app/src/components/NodeDetail.jsx`

**Context:** A simple slide-in panel from the right. Shows summary, transcript excerpt, edge relations. No editing, no fact-checking. Much simpler than the existing 407-LOC NodeDetailPanel.

**Step 1: Create NodeDetail.jsx**

```jsx
import PropTypes from "prop-types";

export default function NodeDetail({ node, onClose }) {
  if (!node) return null;

  const relations = Array.isArray(node.edge_relations) ? node.edge_relations : [];
  const contextualRelations = node.contextual_relation
    ? Object.entries(node.contextual_relation)
    : [];

  return (
    <div className="fixed top-0 right-0 h-full w-80 max-w-[85vw] bg-white shadow-lg border-l border-gray-200 z-40 flex flex-col animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 truncate pr-2">
          {node.node_name}
        </h3>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 transition shrink-0"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
        {/* Speaker */}
        {node.speaker_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Speaker</span>
            <p className="text-gray-700 mt-0.5">{node.speaker_id}</p>
          </div>
        )}

        {/* Summary */}
        {node.summary && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Summary</span>
            <p className="text-gray-700 mt-0.5 leading-relaxed">{node.summary}</p>
          </div>
        )}

        {/* Full text / transcript excerpt */}
        {node.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transcript</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {node.full_text}
            </p>
          </div>
        )}

        {/* Source excerpt */}
        {node.source_excerpt && !node.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Source</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {node.source_excerpt}
            </p>
          </div>
        )}

        {/* Thread */}
        {node.thread_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Thread</span>
            <p className="text-gray-700 mt-0.5">
              {node.thread_id}
              {node.thread_state && (
                <span className="ml-2 text-xs text-gray-400">({node.thread_state})</span>
              )}
            </p>
          </div>
        )}

        {/* Edge relations */}
        {relations.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Relations</span>
            <ul className="mt-1 space-y-1">
              {relations.map((rel, i) => (
                <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                  <span className="font-medium text-gray-500 shrink-0">
                    {rel.relation_type}
                  </span>
                  <span className="text-gray-400">
                    {rel.related_node}: {rel.relation_text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Fallback contextual relations */}
        {relations.length === 0 && contextualRelations.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Context</span>
            <ul className="mt-1 space-y-1">
              {contextualRelations.map(([name, text]) => (
                <li key={name} className="text-xs text-gray-600">
                  <span className="font-medium text-gray-500">{name}:</span>{" "}
                  {text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Claims */}
        {node.claims && node.claims.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Claims</span>
            <ul className="mt-1 space-y-0.5">
              {node.claims.map((claim, i) => (
                <li key={i} className="text-xs text-gray-600">
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

NodeDetail.propTypes = {
  node: PropTypes.object,
  onClose: PropTypes.func.isRequired,
};
```

**Step 2: Add the slide-in animation to index.css**

Append to `lct_app/src/index.css`:

```css
@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.animate-slideIn {
  animation: slideIn 0.2s ease-out;
}
```

**Step 3: Commit**

```bash
git add lct_app/src/components/NodeDetail.jsx lct_app/src/index.css
git commit -m "feat(ui): create NodeDetail slide-in panel

Minimal right-side panel (~80 LOC) showing:
- Node name, speaker, summary, transcript excerpt
- Thread info, edge relations, claims
- Slide-in animation (0.2s ease-out)
- Close button, scrollable body
- No editing, no fact-checking — read-only for MVP"
```

---

## Phase 3: Wire Everything Together

### Task 6: Create MinimalLegend component

**Files:**
- Create: `lct_app/src/components/MinimalLegend.jsx`

**Step 1: Create MinimalLegend.jsx**

```jsx
import { useState } from "react";
import PropTypes from "prop-types";

const EDGE_LEGEND = [
  { label: "supports", color: "#16a34a" },
  { label: "rebuts", color: "#dc2626" },
  { label: "clarifies", color: "#2563eb" },
  { label: "tangent", color: "#d97706" },
  { label: "returns", color: "#0284c7" },
];

export default function MinimalLegend({ speakerColorMap }) {
  const [open, setOpen] = useState(false);
  const speakers = Object.entries(speakerColorMap || {});

  return (
    <div className="absolute bottom-14 right-4 z-20">
      {open ? (
        <div className="bg-white/95 backdrop-blur rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-3 min-w-[140px] animate-slideIn">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-1.5 right-2 text-gray-400 hover:text-gray-600 text-xs"
          >
            close
          </button>

          {speakers.length > 0 && (
            <div>
              <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
                Speakers
              </span>
              <div className="mt-1 space-y-1">
                {speakers.map(([name, color]) => (
                  <div key={name} className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full border border-gray-300"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-gray-600">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
              Edges
            </span>
            <div className="mt-1 space-y-1">
              {EDGE_LEGEND.map(({ label, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                  <span className="text-gray-600">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="p-2 bg-white/70 hover:bg-white/90 backdrop-blur rounded-full shadow-sm border border-gray-200 text-gray-400 hover:text-gray-600 transition opacity-50 hover:opacity-100"
          title="Legend"
          aria-label="Show legend"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        </button>
      )}
    </div>
  );
}

MinimalLegend.propTypes = {
  speakerColorMap: PropTypes.object,
};
```

**Step 2: Commit**

```bash
git add lct_app/src/components/MinimalLegend.jsx
git commit -m "feat(ui): create MinimalLegend component

Low-opacity icon that expands to show speaker colors and edge types.
Absolute positioned bottom-right of graph area."
```

---

### Task 7: Rewrite NewConversation with all new components

**Files:**
- Modify: `lct_app/src/pages/NewConversation.jsx`

**Context:** This is the final assembly. Wire MinimalGraph, TimelineRibbon, NodeDetail, MinimalLegend, and AudioInput into the layout from ADR-011.

**Step 1: Rewrite NewConversation.jsx**

```jsx
import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";

const SPEAKER_COLORS = [
  "#94a3b8", "#7dd3fc", "#fda4af", "#a5b4fc",
  "#86efac", "#fcd34d", "#c4b5fd", "#67e8f9",
];

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [showBackConfirm, setShowBackConfirm] = useState(false);

  const navigate = useNavigate();

  const latestChunk = graphData?.[graphData.length - 1] || [];
  const hasData = latestChunk.length > 0;

  // Resolve selected node data for detail panel
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return latestChunk.find((n) => n.id === selectedNode) || null;
  }, [selectedNode, latestChunk]);

  // Speaker color map (shared between graph, ribbon, legend)
  const speakerColorMap = useMemo(() => {
    const speakers = [...new Set(latestChunk.map((n) => n.speaker_id).filter(Boolean))];
    const map = {};
    speakers.forEach((s, i) => {
      map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    });
    return map;
  }, [latestChunk]);

  const handleBack = useCallback(() => {
    if (hasData) {
      setShowBackConfirm(true);
    } else {
      navigate("/");
    }
  }, [hasData, navigate]);

  const handleConfirmBack = useCallback(() => {
    // Auto-save handles persistence. Just navigate.
    navigate("/");
  }, [navigate]);

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="absolute top-3 left-3 z-30 p-2 text-gray-300 hover:text-gray-500 transition"
        aria-label="Back"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Back confirmation dialog */}
      {showBackConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-lg p-5 max-w-xs text-center space-y-3">
            <p className="text-sm text-gray-700">
              End recording? Your conversation is saved automatically.
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowBackConfirm(false)}
                className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBack}
                className="px-4 py-1.5 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 transition"
              >
                Save & Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main graph area */}
      <div className="flex-1 relative min-h-0">
        {hasData ? (
          <>
            <MinimalGraph
              graphData={graphData}
              selectedNode={selectedNode}
              setSelectedNode={setSelectedNode}
            />
            <MinimalLegend speakerColorMap={speakerColorMap} />
          </>
        ) : (
          // Empty state — just breathing room
          <div className="w-full h-full" />
        )}

        {/* Node detail panel */}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>

      {/* Timeline ribbon */}
      {hasData && (
        <TimelineRibbon
          graphData={graphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
        />
      )}

      {/* Audio footer */}
      <div className="shrink-0 w-full py-2 px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm">
        <AudioInput
          onDataReceived={(newData) => setGraphData(newData)}
          onChunksReceived={(chunks) => setChunkDict(chunks)}
          chunkDict={chunkDict}
          graphData={graphData}
          conversationId={conversationId}
          setConversationId={setConversationId}
          setMessage={setMessage}
          message={message}
          fileName={fileName}
          setFileName={setFileName}
        />
      </div>
    </div>
  );
}
```

**Step 2: Verify end-to-end**

```bash
cd lct_app && npm run dev
```

Open http://localhost:5173/new:
- Should see warm gray background, small back arrow, mic button at bottom
- Empty state: no graph, no ribbon, just the mic
- Start recording: nodes should appear in the graph, dots in the ribbon
- Click a node: detail panel slides in from right
- Click a ribbon dot: corresponding node selected in graph

**Step 3: Commit**

```bash
git add lct_app/src/pages/NewConversation.jsx
git commit -m "feat(ui): wire NewConversation with MinimalGraph, TimelineRibbon, NodeDetail

ADR-011 MVP layout:
- Edge-to-edge graph canvas
- Timeline ribbon (bottom, hidden when empty)
- Node detail panel (slide-in from right)
- Legend (low opacity, bottom-right)
- Back button with save-and-exit confirmation
- Empty state: just mic button on quiet background
- #fafafa background, no gradient, no borders"
```

---

## Phase 4: AudioInput Simplification

### Task 8: Simplify AudioInput for minimal UI

**Files:**
- Modify: `lct_app/src/components/AudioInput.jsx`

**Context:** The current AudioInput has a large live transcript box (112px scrollable), text status badges, and settings panels inline. For ADR-011, we simplify: smaller mic button, a single status dot (green/yellow/red), and the live transcript becomes a 2-3 line overlay. Settings accessible via gear icon.

**Step 1: Read and understand the current AudioInput.jsx**

The file is 324 LOC. Everything above line 242 (hooks, state, orchestration) stays unchanged.
We are ONLY replacing the JSX return (lines 242-309) and removing unused helpers at the top.

**Step 2: Replace the JSX return block**

Replace lines 242-309 (the `return (` through the closing `</div>`) with:

```jsx
  // Derive aggregate status: worst of mic/provider/backend
  const aggregateStatus = (() => {
    if ([providerSocketState, backendSocketState].some((s) => normalizeSocketState(s) === "error")) return "error";
    if ([providerSocketState, backendSocketState].some((s) => normalizeSocketState(s) === "connecting")) return "connecting";
    if (recording) return "connected";
    return "idle";
  })();

  const statusDotColor = {
    idle: "bg-gray-300",
    connecting: "bg-amber-400 animate-pulse",
    connected: "bg-emerald-400",
    error: "bg-red-400",
  }[aggregateStatus];

  const statusTooltip = `Mic: ${recording ? "recording" : "idle"} | STT: ${prettifySocketState(providerSocketState)} | Backend: ${prettifySocketState(backendSocketState)}`;

  // Show last 3 transcript lines for live caption
  const captionLines = liveTranscriptLines.slice(-3);

  return (
    <div className="flex items-center gap-3">
      {/* Live caption (above footer, positioned by parent) */}
      {recording && captionLines.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-black/5 backdrop-blur-sm rounded-lg px-3 py-1.5 text-xs text-gray-500 space-y-0.5">
            {captionLines.map((line) => (
              <p key={line.id} className={line.isFinal ? "text-gray-600" : "text-gray-400 italic"}>
                {line.text}{!line.isFinal ? " ..." : ""}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Mic button */}
      <button
        onClick={recording ? stopRecording : startRecording}
        className={`relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none ${
          recording
            ? "bg-red-100 text-red-600 hover:bg-red-200"
            : "bg-gray-100 text-gray-500 hover:bg-gray-200"
        }`}
        aria-label={recording ? "Stop recording" : "Start recording"}
      >
        <Mic size={18} />
        {recording && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
        )}
      </button>

      {/* Status dot */}
      <div
        className={`w-2 h-2 rounded-full ${statusDotColor} shrink-0`}
        title={statusTooltip}
      />

      {/* Error messages (inline, compact) */}
      {settingsError && (
        <span className="text-[10px] text-red-500">{settingsError}</span>
      )}
      {processingError && (
        <span className="text-[10px] text-amber-600">{processingError}</span>
      )}
    </div>
  );
```

**Step 3: Remove unused helpers at the top of the file**

Delete the `SOCKET_STATE_STYLES` object (lines 18-24), `statusChipClass` function (lines 48-51), and the `LIVE_TRANSCRIPT_MAX_LINES` constant (line 16). Keep `normalizeSocketState` and `prettifySocketState` — they are used by the status tooltip. Also reduce `LIVE_TRANSCRIPT_MAX_LINES` or remove it (the slice(-3) handles limiting now). Keep `upsertLiveTranscriptLine` — the state hook still uses it.

**Step 4: Test recording flow**

Start recording, verify:
- Mic button changes state
- Status dot reflects connection
- 2-3 lines of live text appear
- Graph receives data

**Step 4: Commit**

```bash
git add lct_app/src/components/AudioInput.jsx
git commit -m "refactor(ui): simplify AudioInput for minimal layout

- Compact mic button (no large circle)
- Single status dot (green/yellow/red) instead of text badges
- 2-3 line live caption instead of scrollable transcript box
- Gear icon for settings access
- All audio pipeline hooks unchanged"
```

---

## Phase 5: Responsive & Polish

### Task 9: Responsive design for phone/tablet

**Files:**
- Modify: `lct_app/src/components/NodeDetail.jsx`
- Modify: `lct_app/src/pages/NewConversation.jsx`

**Context:** The app is accessed on phones/tablets via Tailscale. The detail panel should be full-width overlay on small screens. Touch targets must be >= 44px.

**Step 1: Update NodeDetail for mobile**

Change the panel width classes:
```
w-80 max-w-[85vw]
```
to:
```
w-full sm:w-80 sm:max-w-[85vw]
```

This makes the panel full-width on phones and 320px on tablets/laptops.

**Step 2: Verify touch targets**

Audit all clickable elements. Ensure:
- Mic button: >= 44px
- Back button: >= 44px tap target (padding)
- Timeline dots: >= 44px tap area (even if visual dot is 8px)
- Legend button: >= 44px
- Detail panel close button: >= 44px

For timeline dots, increase the `<button>` padding:
```jsx
style={{ width: "44px", height: "44px" }}
```
while keeping the visual dot small inside it.

**Step 3: Test on mobile viewport**

Use browser DevTools responsive mode (iPhone 14 Pro, iPad) to verify:
- Graph fills screen
- Ribbon is visible and scrollable
- Detail panel overlays full-width
- Mic button is reachable and large enough

**Step 4: Commit**

```bash
git add lct_app/src/components/NodeDetail.jsx lct_app/src/components/TimelineRibbon.jsx lct_app/src/pages/NewConversation.jsx
git commit -m "feat(ui): responsive design for phone/tablet via Tailscale

- NodeDetail: full-width on mobile, 320px on desktop
- TimelineRibbon: 44px touch targets on dots
- All interactive elements meet 44px minimum tap area
- Tested at iPhone 14 Pro and iPad viewports"
```

---

### Task 10: Remove dead code and clean up imports

**Files:**
- Modify: `lct_app/src/pages/NewConversation.jsx` (remove any unused imports)
- No deletion of old component files yet (they may be used by other routes)

**Step 1: Check if ContextualGraph, StructuralGraph, etc. are imported elsewhere**

```bash
cd lct_app && grep -r "ContextualGraph\|StructuralGraph\|GenerateFormalism\|FormalismList\|SaveJson\|SaveTranscript" src/ --include="*.jsx" --include="*.js" -l
```

If they are only imported in the old NewConversation.jsx (which we've rewritten), they are now dead code. Note which files are safe to mark as dead in TECH_DEBT.md.

**Step 2: Verify all routes still work**

```bash
cd lct_app && npm run dev
```

Navigate through: `/`, `/new`, `/browse`, any saved conversation. Confirm nothing is broken.

**Step 3: Commit**

```bash
git status
# Review output. Only stage files we intentionally changed. Do NOT use git add -A.
# If no changes needed beyond what's already committed, skip this commit.
git commit -m "chore: verify no broken imports after NewConversation rewrite

All routes confirmed working. Old components (ContextualGraph, StructuralGraph,
GenerateFormalism, etc.) are now unused by /new route but may be referenced
by other routes — left in place pending full audit."
```

---

### Task 11: Update ADR-011 status and document completion

**Files:**
- Modify: `docs/adr/ADR-011-minimal-live-conversation-ui.md`

**Step 1: Keep ADR as Draft — add implementation notes only**

Do NOT change status to Approved until all verification checklist items pass.
Leave status as Draft. Add implementation notes.

**Step 2: Add implementation notes section**

Add at the bottom of the ADR:
```markdown
## Implementation Notes (2026-02-14)

MVP implemented on branch `feat/minimal-live-ui`. Key files:

| Component | File | LOC | Purpose |
|-----------|------|-----|---------|
| MinimalGraph | `components/MinimalGraph.jsx` | ~200 | ReactFlow + dagre, pill nodes, typed edges |
| TimelineRibbon | `components/TimelineRibbon.jsx` | ~80 | Plain DOM timeline strip |
| NodeDetail | `components/NodeDetail.jsx` | ~120 | Slide-in detail panel |
| MinimalLegend | `components/MinimalLegend.jsx` | ~80 | Collapsible legend |
| NewConversation | `pages/NewConversation.jsx` | ~120 | Page assembly |

Total new code: ~600 LOC (replaces ~1,400 LOC of old UI code).
```

**Step 3: Commit**

```bash
git add docs/adr/ADR-011-minimal-live-conversation-ui.md
git commit -m "docs: update ADR-011 status to Approved with implementation notes"
```

---

## Verification Checklist

After all tasks, verify against ADR-011 success criteria:

- [ ] Empty state: quiet background + mic button only (no broken canvases)
- [ ] Recording: nodes appear as colored pills with anchor words
- [ ] Edges: thin colored lines with hover tooltips
- [ ] Timeline ribbon: colored dots, auto-scrolls, click to select
- [ ] Node click: detail panel slides in from right, shows summary + transcript
- [ ] Legend: low opacity icon, expands to show speakers + edge types
- [ ] Back button: confirmation dialog when data exists
- [ ] No gradient, no ReactFlow dots/watermark, no emoji, no debug badges
- [ ] Inter font renders correctly
- [ ] Responsive: works on phone viewport (375px width)
- [ ] Auto-save: conversation persists without explicit save action (existing hook)
- [ ] Graph auto-pans to follow latest nodes
- [ ] No console.log debug spam in production

---

## Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1: Setup & Strip | 1-2 | Branch, Inter font, remove dead features |
| 2: New Components | 3-6 | MinimalGraph, TimelineRibbon, NodeDetail, MinimalLegend |
| 3: Assembly | 7 | Wire everything into NewConversation |
| 4: AudioInput | 8 | Simplify mic button, status, transcript |
| 5: Polish | 9-11 | Responsive, cleanup, ADR update |

**Estimated commits:** 11
**New files:** 4 components
**Modified files:** 3 (NewConversation, AudioInput, index.css)
**Deleted features:** formalism, fact-checking, bookmarks, gradient, debug logging
**Net LOC change:** ~600 new, ~1400 old → ~800 LOC reduction
