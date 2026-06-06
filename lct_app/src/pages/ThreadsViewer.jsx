import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import TimelineRibbon from "../components/TimelineRibbon";
import { buildSpeakerColorMap } from "../components/graphConstants";

/**
 * Static, server-free viewer for a `.threads` artifact (ADR-036).
 *
 * The whole point: this renders a self-contained conversation map entirely
 * client-side. It makes ZERO /api/ calls — possession of the file is the
 * capability, there is no token, no auth, no backend at view time. (App.jsx
 * exempts /view from the backend-reachability gate.)
 *
 * The data comes from a `.threads` file (drag-drop, file-picker, or ?src=<url>).
 * We pass NO conversationId to the child components, which gates off every
 * backend call they would otherwise make (fact-check, speaker fetch/save,
 * preference persistence, utterance loading). Audio is not part of the bundle.
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — reject oversized files pre-parse
const MAX_NODES = 50000; // main-thread / memory DoS guard before ReactFlow
const SUPPORTED_VERSIONS = new Set([1]);

function flattenGraph(graphData) {
  // graph_data may be a FLAT list of node objects (build_graph_data_from_nodes /
  // the .threads export) OR an array-of-arrays (chunked). Handle both — otherwise
  // selectedNodeData + speakerColorMap come back empty and node-detail-on-click
  // silently does nothing.
  return (graphData || []).flatMap((entry) =>
    Array.isArray(entry)
      ? entry.filter((n) => n && typeof n === "object" && !Array.isArray(n))
      : entry && typeof entry === "object"
        ? [entry]
        : [],
  );
}

function validateThreads(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Not a .threads object.");
  }
  if (data.format !== "lct.threads") {
    throw new Error("This file is not a .threads artifact.");
  }
  if (!SUPPORTED_VERSIONS.has(data.format_version)) {
    throw new Error(
      `Unsupported .threads version (${data.format_version}). Update the viewer.`,
    );
  }
  if (!Array.isArray(data.graph_data)) {
    throw new Error("Missing or invalid graph_data.");
  }
  if (data.chunk_dict != null && typeof data.chunk_dict !== "object") {
    throw new Error("Invalid chunk_dict.");
  }
  const nodeCount = data.graph_data.reduce(
    (acc, chunk) => acc + (Array.isArray(chunk) ? chunk.length : 0),
    0,
  );
  if (nodeCount > MAX_NODES) {
    throw new Error(`Artifact too large (${nodeCount} nodes).`);
  }
  return data;
}

export default function ThreadsViewer() {
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);
  // The part of the conversation currently fanned into (null = whole call). Drives
  // the dynamic header so the title/summary track where you've zoomed.
  const [focusNode, setFocusNode] = useState(null);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const fileInputRef = useRef(null);

  const ingest = useCallback((data) => {
    try {
      setBundle(validateThreads(data));
      setError("");
      setSelectedNode(null);
    } catch (e) {
      setBundle(null);
      setError(String(e?.message || e));
    }
  }, []);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      if (file.size > MAX_BYTES) {
        setError("That file is too large to open.");
        return;
      }
      try {
        const text = await file.text();
        ingest(JSON.parse(text));
      } catch (e) {
        setBundle(null);
        setError(`Could not read .threads file: ${String(e?.message || e)}`);
      }
    },
    [ingest],
  );

  // Optional ?src=<url> — fetch a hosted .threads (NOT an /api/ call). Lets a
  // share be a plain link to a hosted file without any backend.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const src = new URLSearchParams(window.location.search).get("src");
    if (!src) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const data = await resp.json();
        if (!cancelled) ingest(data);
      } catch (e) {
        if (!cancelled) setError(`Could not load artifact: ${String(e?.message || e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingest]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      void handleFile(file);
    },
    [handleFile],
  );

  const flatNodes = useMemo(
    () => (bundle ? flattenGraph(bundle.graph_data) : []),
    [bundle],
  );
  const speakerColorMap = useMemo(() => buildSpeakerColorMap(flatNodes), [flatNodes]);
  const selectedNodeData = useMemo(
    () =>
      selectedNode
        ? flatNodes.find((n) => String(n.id) === String(selectedNode)) || null
        : null,
    [flatNodes, selectedNode],
  );

  // ---- Empty state: drop zone ---------------------------------------------
  if (!bundle) {
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // dragleave bubbles as the cursor crosses child elements; only clear
          // the highlight when it actually leaves the window (relatedTarget null).
          if (e.relatedTarget === null) setDragging(false);
        }}
        onDrop={onDrop}
        className={`flex h-[100dvh] w-screen items-center justify-center p-6 font-sans transition ${
          dragging ? "bg-amber-100" : "bg-[#fafafa]"
        }`}
      >
        <div
          className={`flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition ${
            dragging ? "border-amber-400 bg-amber-50" : "border-slate-300 bg-white"
          }`}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-400">
            Threads · conversation map
          </p>
          <h1 className="text-lg font-semibold text-slate-800">
            Open a <span className="font-mono">.threads</span> file
          </h1>
          <p className="text-sm text-slate-500">
            Drop it anywhere on this screen, or pick a file below. Everything
            renders in your browser — nothing is uploaded.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Choose file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".threads,application/json"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          {error && (
            <p className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- Loaded state: the map ----------------------------------------------
  return (
    <div className="flex h-[100dvh] w-screen flex-col bg-[#fafafa] font-sans">
      {(() => {
        const TIER = { 1: "moment", 2: "idea", 3: "topic", 4: "theme", 5: "arc" };
        const headerTitle =
          focusNode?.title ||
          bundle.conversation_title ||
          bundle.conversation_name ||
          "Untitled";
        const headerSummary = focusNode?.summary || bundle.executive_summary || "";
        const eyebrow = focusNode
          ? `Zoomed into ${TIER[focusNode.level] || "a part"} · ${focusNode.depth} level${focusNode.depth > 1 ? "s" : ""} deep`
          : "Conversation map · read-only";
        return (
          <header className="shrink-0 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <p className="truncate text-[10px] font-medium uppercase tracking-[0.24em] text-slate-400">
                    {eyebrow}
                  </p>
                  {headerSummary && (
                    <button
                      type="button"
                      onClick={() => setSummaryCollapsed((c) => !c)}
                      className="shrink-0 text-[10px] font-medium text-slate-400 hover:text-slate-700"
                    >
                      {summaryCollapsed ? "▸ summary" : "▾ summary"}
                    </button>
                  )}
                </div>
                <h1 className="truncate text-base font-semibold text-slate-800">
                  {headerTitle}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => {
                  setBundle(null);
                  setError("");
                }}
                className="shrink-0 rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
              >
                Open another
              </button>
            </div>
            {!summaryCollapsed && headerSummary && (
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                {headerSummary}
              </p>
            )}
          </header>
        );
      })()}

      <div className="relative min-h-0 flex-1">
        <MinimalGraph
          graphData={bundle.graph_data}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          onVisibleLevelChange={(view) => {
            setVisibleGraphLevel(view?.mode === "semantic" ? view.level : null);
          }}
          onFocusChange={setFocusNode}
          argumentTraceFrom={argumentTraceFrom}
          setArgumentTraceFrom={setArgumentTraceFrom}
        />
        <MinimalLegend speakerColorMap={speakerColorMap} />
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={bundle.chunk_dict || {}}
            contextNodes={flatNodes}
            onSelectNode={setSelectedNode}
            onClose={() => setSelectedNode(null)}
            onTraceAncestors={setArgumentTraceFrom}
          />
        )}
      </div>

      {flatNodes.length > 0 && (
        <TimelineRibbon
          graphData={bundle.graph_data}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          semanticLevel={visibleGraphLevel}
        />
      )}
    </div>
  );
}
