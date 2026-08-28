import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useDataProvider } from "../services/dataProvider";
import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import TimelineRibbon from "../components/TimelineRibbon";
import ThreadsFileButton from "../components/threads/ThreadsFileButton";
import DriveThreadsGate from "../components/threads/DriveThreadsGate";
import ThreadsViewerHeader from "../components/threads/ThreadsViewerHeader";
import { buildSpeakerColorMap } from "../components/graphConstants";
import {
  flattenThreadsGraph,
  readThreadsFile,
  validateThreadsArtifact,
} from "../services/threadsArtifact";
import { indexExplicitEdges } from "../services/edgeContract";
import { enrichGraphNodesWithProvenance } from "../components/graphProvenance";
import {
  getThreadsLibraryRecord,
  rememberThreadsArtifact,
} from "../services/threadsLibraryStore";

/**
 * Static, LCT-backend-free viewer for a `.threads` artifact (ADR-036).
 *
 * The whole point: this renders a self-contained conversation map entirely
 * client-side. It makes ZERO LCT /api/ calls. A local file is a possession
 * capability; a Drive link instead uses recipient Google authorization solely
 * to fetch the permissioned artifact. (App.jsx exempts /view from the
 * backend-reachability gate.)
 *
 * The data comes from a `.threads` file (drag-drop, file-picker, ?src=<url>, or
 * a recipient-authorized Google Drive fetch via ?driveFile=<file-id>).
 * We pass NO conversationId to the child components, which gates off every
 * backend call they would otherwise make (fact-check, speaker fetch/save,
 * preference persistence, utterance loading). Audio is not part of the bundle.
 */

export default function ThreadsViewer() {
  const dataProvider = useDataProvider();
  const location = useLocation();
  const navigate = useNavigate();
  const { artifactId } = useParams();
  const driveFileId = typeof window === "undefined"
    ? ""
    : new URLSearchParams(location.search).get("driveFile") || "";
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState("");
  const [libraryStatus, setLibraryStatus] = useState(null);
  const [dragging, setDragging] = useState(false);
  // True while a ?src= hosted artifact is fetching, so a recipient who opened a
  // shared link sees a loading state — not the "drop a file" prompt — until the
  // map arrives. Seeded from the URL so the very first render is already loading.
  const [srcLoading, setSrcLoading] = useState(
    () =>
      Boolean(artifactId || location.state?.threadsBundle) ||
      (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("src")),
  );
  const [selectedNode, setSelectedNode] = useState(null);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);
  // The part of the conversation currently fanned into (null = whole call). Drives
  // the dynamic header so the title/summary track where you've zoomed.
  const [focusNode, setFocusNode] = useState(null);
  // Canvas-only "focus mode": hide all chrome (header, legend, timeline, graph
  // toolbar) so only the nodes remain. Esc exits.
  const [focusMode, setFocusMode] = useState(false);
  const consumedRouteState = useRef(false);

  useEffect(() => {
    if (!focusMode) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  const ingest = useCallback((data, { sourceName = "", remember = true } = {}) => {
    try {
      const validated = validateThreadsArtifact(data);
      setBundle(validated);
      setError("");
      setSelectedNode(null);
      if (remember) {
        setLibraryStatus({ state: "saving", message: "Saving on this device…" });
        void rememberThreadsArtifact(validated, { sourceName })
          .then((record) => {
            setLibraryStatus({
              state: "saved",
              message: "Saved on this device",
              recordId: record.id,
            });
          })
          .catch((storageError) => {
            console.error("[ThreadsViewer] Could not remember artifact:", storageError);
            setLibraryStatus({
              state: "error",
              message: `Open, but not saved: ${String(storageError?.message || storageError)}`,
            });
          });
      }
    } catch (e) {
      setBundle(null);
      setError(String(e?.message || e));
    }
  }, []);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const data = await readThreadsFile(file);
        ingest(data, { sourceName: file.name });
      } catch (e) {
        setBundle(null);
        setError(`Could not read .threads file: ${String(e?.message || e)}`);
      }
    },
    [ingest],
  );

  // Browse passes a parsed bundle through router state so the file opens even
  // when persistent browser storage is unavailable. The viewer then attempts
  // the one shared remember step and reports its result honestly in the header.
  useEffect(() => {
    const routedBundle = location.state?.threadsBundle;
    if (!routedBundle || consumedRouteState.current) return;
    consumedRouteState.current = true;
    ingest(routedBundle, { sourceName: location.state?.sourceName || "" });
    setSrcLoading(false);
  }, [ingest, location.state]);

  // Stable browser-local deep link used by Browse's "On this device" rows.
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    setSrcLoading(true);
    void getThreadsLibraryRecord(artifactId)
      .then((record) => {
        if (cancelled) return;
        if (!record) {
          throw new Error("This saved conversation is no longer on this device.");
        }
        ingest(record.bundle, { sourceName: record.sourceName, remember: false });
        setLibraryStatus({ state: "saved", message: "Saved on this device", recordId: record.id });
      })
      .catch((loadError) => {
        if (!cancelled) {
          setBundle(null);
          setError(`Could not open saved artifact: ${String(loadError?.message || loadError)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setSrcLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, ingest]);

  // Optional ?src=<url> — fetch a hosted .threads (NOT an /api/ call). Lets a
  // share be a plain link to a hosted file without any backend.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (artifactId || location.state?.threadsBundle) return;
    const src = new URLSearchParams(window.location.search).get("src");
    if (!src) return;
    let cancelled = false;
    setSrcLoading(true);
    (async () => {
      try {
        const resp = await dataProvider.conversations.fetchThreadsFile(src);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const data = await resp.json();
        if (!cancelled) ingest(data, { sourceName: src });
      } catch (e) {
        if (!cancelled) setError(`Could not load artifact: ${String(e?.message || e)}`);
      } finally {
        if (!cancelled) setSrcLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, dataProvider, ingest, location.state]);

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
    () => (bundle
      ? enrichGraphNodesWithProvenance(indexExplicitEdges(
        flattenThreadsGraph(bundle.graph_data),
        bundle.edges,
        true,
      ), bundle.utterances || [])
      : []),
    [bundle],
  );
  const speakerColorMap = useMemo(() => buildSpeakerColorMap(flatNodes), [flatNodes]);
  // Diagnostic (cold-open blank-graph investigation): confirms MinimalGraph
  // mounts only AFTER the .threads bundle is present, with a non-empty node
  // count — distinguishes the data-ready path (blank => camera) from a
  // data-arrival race. Toggle off with window.__MG_DEBUG__ = false.
  useEffect(() => {
    if (typeof window !== "undefined" && (window.__MG_DEBUG__ ?? true)) {
      console.log("[ThreadsViewer] bundle ready -> MinimalGraph", { graphDataLen: (bundle?.graph_data || []).length, flatNodes: flatNodes.length });
    }
  }, [bundle, flatNodes.length]);
  const selectedNodeData = useMemo(
    () =>
      selectedNode
        ? flatNodes.find((n) => String(n.id) === String(selectedNode)) || null
        : null,
    [flatNodes, selectedNode],
  );

  // Download the raw transcript reconstructed from the artifact's chunk
  // source-excerpts (the verbatim words the map was built from) — so a reader
  // can compare the summarized nodes against what was actually said. Grouped by
  // conversation (chronologically) when the artifact is a multi-meeting corpus,
  // ordered within each by sequence/timestamp. Pure client-side; no new hosting.
  const downloadTranscript = useCallback(() => {
    if (!bundle) return;
    const triggerDownload = (text) => {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (bundle.conversation_title || "transcript").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
      a.href = url;
      a.download = `${safe}-transcript.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };
    // Prefer the bundled FULL verbatim transcript (complete turns from source)
    // when present. The chunk reconstruction below is only a lossy fallback — the
    // chunk source-excerpts are representative snippets, not the whole call.
    if (typeof bundle.full_transcript === "string" && bundle.full_transcript.trim()) {
      triggerDownload(
        `# ${bundle.conversation_title || "Conversation"} — full transcript\n`
          + `# ${bundle.transcript_source || "verbatim source"}\n\n`
          + bundle.full_transcript,
      );
      return;
    }
    const nodes = flatNodes || [];
    const chunks = nodes.filter(
      (n) => n.semantic_type === "chunk" || Number(n.semantic_level) === 1 || Number(n.level) === 1,
    );
    const source = chunks.length ? chunks : nodes.filter((n) => n.source_excerpt);
    const seqOf = (n) => {
      const s = Number(n.sequence_number);
      if (Number.isFinite(s)) return s;
      const t = Number(n.timestamp_start);
      if (Number.isFinite(t)) return t;
      return Number.MAX_SAFE_INTEGER;
    };
    const groups = new Map(); // label -> { date, idx, nodes }
    source.forEach((n) => {
      const label = n.meeting_label || "";
      if (!groups.has(label)) groups.set(label, { date: n.meeting_date || "", idx: n.meeting_idx ?? 9999, nodes: [] });
      groups.get(label).nodes.push(n);
    });
    const lines = [
      `# ${bundle.conversation_title || bundle.conversation_name || "Conversation"} — raw transcript`,
      `# Reconstructed from the artifact's source excerpts. Compare against the map at /view.`,
      "",
    ];
    [...groups.entries()]
      .sort((a, b) => (a[1].date || "").localeCompare(b[1].date || "") || a[1].idx - b[1].idx)
      .forEach(([label, meta]) => {
        if (label) {
          lines.push("", `## ${label}${meta.date ? ` — ${meta.date}` : ""}`, "");
        }
        meta.nodes
          .slice()
          .sort((a, b) => seqOf(a) - seqOf(b))
          .forEach((n) => {
            const sp = n.speaker_display || n.speaker_id || "?";
            const ex = (n.source_excerpt || n.summary || "").trim();
            if (ex) lines.push(`[${sp}] ${ex}`);
          });
      });
    triggerDownload(lines.join("\n"));
  }, [bundle, flatNodes]);

  // ---- Loading state: fetching a hosted ?src= artifact --------------------
  if (!bundle && srcLoading && !error) {
    return (
      <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#fafafa] font-sans">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <span
            aria-hidden="true"
            className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
          />
          <p className="text-sm">Loading the conversation map…</p>
        </div>
      </div>
    );
  }

  // ---- Empty state: drop zone ---------------------------------------------
  if (!bundle) {
    if (driveFileId) {
      return (
        <DriveThreadsGate
          fileId={driveFileId}
          onArtifact={(artifact, options) => ingest(artifact, options)}
        />
      );
    }
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
          <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">
            Threads · conversation map
          </p>
          <h1 className="text-lg font-semibold text-slate-800">
            Open a <span className="font-mono">.threads</span> file
          </h1>
          <p className="text-sm text-slate-500">
            Drop it anywhere on this screen, or pick a file below. Everything
            renders in your browser. Nothing is uploaded. Valid files are
            remembered in this browser&apos;s library.
          </p>
          <ThreadsFileButton
            label="Choose file"
            showIcon={false}
            onFileSelected={handleFile}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          />
          <button
            type="button"
            onClick={() => navigate("/browse")}
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            Back to library
          </button>
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
    <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-[#fafafa] font-sans">
      {!focusMode && (
        <ThreadsViewerHeader
          bundle={bundle}
          focusNode={focusNode}
          libraryStatus={libraryStatus}
          onDownloadTranscript={downloadTranscript}
          onEnterFocus={() => setFocusMode(true)}
          onOpenLibrary={() => navigate("/browse")}
          onOpenAnother={() => {
            setBundle(null);
            setError("");
            setLibraryStatus(null);
            navigate("/view");
          }}
        />
      )}

      <div className="relative min-h-0 flex-1">
        <MinimalGraph
          graphData={flatNodes}
          semanticEdges={bundle.edges}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          onVisibleLevelChange={(view) => {
            if (typeof window !== "undefined" && (window.__MG_DEBUG__ ?? true)) {
              console.log("[ThreadsViewer] onVisibleLevelChange", { mode: view?.mode, level: view?.level, label: view?.label, ribbonLevel: view?.mode === "semantic" ? view.level : null });
            }
            setVisibleGraphLevel(view?.mode === "semantic" ? view.level : null);
          }}
          onFocusChange={setFocusNode}
          chromeless={focusMode}
          argumentTraceFrom={argumentTraceFrom}
          setArgumentTraceFrom={setArgumentTraceFrom}
        />
        {focusMode && (
          <button
            type="button"
            onClick={() => setFocusMode(false)}
            title="Exit focus mode (Esc)"
            className="absolute right-3 top-3 z-50 min-h-11 rounded-md bg-white/70 px-3 py-1 text-[11px] text-slate-500 shadow-sm backdrop-blur hover:bg-white hover:text-slate-800 sm:min-h-0 sm:px-2.5"
          >
            ✕ Exit focus
          </button>
        )}
        {!focusMode && <MinimalLegend speakerColorMap={speakerColorMap} />}
        {selectedNodeData && (
          <button
            type="button"
            aria-label="Close node details"
            className="fixed inset-0 z-[35] bg-slate-950/20 backdrop-blur-[1px] sm:hidden"
            onClick={() => setSelectedNode(null)}
          />
        )}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={bundle.chunk_dict || {}}
            artifactUtterances={bundle.utterances || []}
            mediaRefs={bundle.media_refs || []}
            contextNodes={flatNodes}
            onSelectNode={setSelectedNode}
            onClose={() => setSelectedNode(null)}
            onTraceAncestors={setArgumentTraceFrom}
          />
        )}
      </div>

      {!focusMode && flatNodes.length > 0 && (
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
