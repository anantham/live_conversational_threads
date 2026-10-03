import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Rows3 } from "lucide-react";
import PropTypes from "prop-types";

import { useDataProvider } from "../services/dataProvider";
import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import TimelineRibbon from "../components/TimelineRibbon";
import ThreadsFileButton from "../components/threads/ThreadsFileButton";
import DriveThreadsGate from "../components/threads/DriveThreadsGate";
import PublicDriveThreadsGate from "../components/threads/PublicDriveThreadsGate";
import ThreadsViewerHeader from "../components/threads/ThreadsViewerHeader";
import ThreadsViewerToolbar from "../components/threads/ThreadsViewerToolbar";
import { buildViewerFindGroups } from "../components/threads/viewerFindModel";
import DiscussionView from "../components/discussion/DiscussionView";
import PublicThreadsLoader from "./PublicThreadsLoader";
import MobileConversationDeck from "../components/threads/MobileConversationDeck";
import YouTubeSourcePanel from "../components/threads/YouTubeSourcePanel";
import {CardDisplayProvider,CardDisplaySettings} from "../components/threads/CardDisplaySettings";
import {withThreadLanes} from "../components/threads/threadPresentation";
import {buildMobileConversationDeck,mobileDeckStateForNode} from "../components/threads/mobileConversationDeckModel";
import { renameArtifactSpeaker, selectYouTubeRef } from "../services/youtubeMedia";
import { buildSpeakerColorMapForNodes } from "../components/graph/colorModes";
import { COMPACT_VIEWER_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import {
  flattenThreadsGraph,
  readThreadsFile,
  validateThreadsArtifact,
} from "../services/threadsArtifact";
import { indexExplicitEdges } from "../services/edgeContract";
import { readGeneratedMap, releaseGeneratedMap } from "../services/cloud/generatedMapHandoff.js";
import { enrichGraphNodesWithProvenance } from "../components/graphProvenance";
import {
  getThreadsLibraryRecord,
  getThreadsLibraryRecordByDriveFileId,
  rememberThreadsArtifact,
} from "../services/threadsLibraryStore";

/**
 * Static, LCT-backend-free viewer for a `.threads` artifact (ADR-036).
 *
 * The whole point: this renders a self-contained conversation map entirely
 * client-side. It makes no private LCT backend calls. A local file is a possession
 * capability; a Drive link instead uses recipient Google authorization solely
 * to fetch the permissioned artifact. (App.jsx exempts /view from the
 * backend-reachability gate.)
 * Explicit &public=1 links use a credential-free public Drive relay instead.
 *
 * The data comes from a `.threads` file (drag-drop, file-picker, ?src=<url>, or
 * a recipient-authorized Google Drive fetch via ?driveFile=<file-id>).
 * We pass NO conversationId to the child components, which gates off every
 * backend call they would otherwise make (fact-check, speaker fetch/save,
 * preference persistence, utterance loading). Audio is not part of the bundle.
 */

export default function ThreadsViewer({ privateBundle, onPrivateClose }) {
  return <CardDisplayProvider><ThreadsViewerContent privateBundle={privateBundle} onPrivateClose={onPrivateClose} /></CardDisplayProvider>;
}

function ThreadsViewerContent({ privateBundle, onPrivateClose }) {
  const privateMode = privateBundle !== undefined;
  const dataProvider = useDataProvider();
  const location = useLocation();
  const navigate = useNavigate();
  const { artifactId, publicId } = useParams();
  const generatedMapId = !privateMode && !publicId && location.state?.remember === false ? location.state?.generatedMapId : null;
  const generatedBundle = useMemo(() => readGeneratedMap(generatedMapId), [generatedMapId]);
  const ephemeral = !privateMode && !publicId && location.state?.remember === false && Boolean(generatedMapId || location.state?.threadsBundle);
  const driveFileId = privateMode || typeof window === "undefined"
    ? ""
    : new URLSearchParams(location.search).get("driveFile") || "";
  const DriveOpener = new URLSearchParams(location.search).get("public") === "1"
    ? PublicDriveThreadsGate : DriveThreadsGate;
  const [bundle, setBundle] = useState(null);
  const [viewMode, setViewMode] = useState(() => !privateMode && typeof window !== "undefined" && window.location.hash.startsWith("#discussion=") ? "discussion" : "graph");
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [graphToolsHost, setGraphToolsHost] = useState(null);
  const [graphTierHost, setGraphTierHost] = useState(null);
  const [discussionFocus, setDiscussionFocus] = useState(null);
  const [error, setError] = useState("");
  const [libraryStatus, setLibraryStatus] = useState(null);
  const [dragging, setDragging] = useState(false);
  // True while a ?src= hosted artifact is fetching, so a recipient who opened a
  // shared link sees a loading state — not the "drop a file" prompt — until the
  // map arrives. Seeded from the URL so the very first render is already loading.
  const [srcLoading, setSrcLoading] = useState(
    () =>
      privateMode || Boolean(artifactId || generatedMapId || location.state?.threadsBundle) ||
      (typeof window !== "undefined"
        && ["src", "driveFile"].some((key) => new URLSearchParams(window.location.search).has(key))),
  );
  const [driveRefreshRequested, setDriveRefreshRequested] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [mediaNode, setMediaNode] = useState(null);
  const [sourceSeek, setSourceSeek] = useState(null);
  const sourceSeekHandled = useCallback(() => setSourceSeek(null), []);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);
  // The part of the conversation currently fanned into (null = whole call). Drives
  // the dynamic header so the title/summary track where you've zoomed.
  const [focusNode, setFocusNode] = useState(null);
  // Canvas-only "focus mode": hide all chrome (header, legend, timeline, graph
  // toolbar) so only the nodes remain. Esc exits.
  const [focusMode, setFocusMode] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(false);
  const [mapTarget, setMapTarget] = useState(null);
  const [mapRequest,setMapRequest]=useState(0);
  const requestMapTarget=useCallback((id)=>{setMapTarget(id);setMapRequest(n=>n+1);},[]);
  const [mobileDeckState, setMobileDeckState] = useState(null);
  const [mobileReadingPath,setMobileReadingPath]=useState("");
  const consumedRouteState = useRef(false);
  const compactViewer = useMediaQuery(COMPACT_VIEWER_QUERY);
  const narrowViewer = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    if (!compactViewer && viewMode === "cards") {
      setViewMode("graph");
      setMobileMapOpen(false);
    }
  }, [compactViewer, viewMode]);

  useEffect(() => {
    if (privateMode) return;
    const showLinkedDiscussion = () => {
      if (window.location.hash.startsWith("#discussion=")) {
        setFocusMode(false);
        setMobileMapOpen(false);
        setViewMode("discussion");
      }
    };
    window.addEventListener("hashchange", showLinkedDiscussion);
    return () => window.removeEventListener("hashchange", showLinkedDiscussion);
  }, [privateMode]);

  useEffect(() => {
    if (!focusMode) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  const ingest = useCallback((data, {
    sourceName = "",
    driveFileId: sourceDriveFileId = "",
    remember = true,
  } = {}) => {
    try {
      const validated = validateThreadsArtifact(data);
      setBundle(validated);
      setViewMode(!privateMode && typeof window !== "undefined" && window.location.hash.startsWith("#discussion=") ? "discussion" : "graph");
      setOverviewOpen(false);
      setSourceOpen(false);
      setTimelineOpen(false);
      setDiscussionFocus(null);
      setError("");
      setSelectedNode(null);
      setMediaNode(null);
      setMobileMapOpen(false);
      setMobileDeckState(null);
      if (remember && !privateMode) {
        setLibraryStatus({ state: "saving", message: "Saving on this device…" });
        void rememberThreadsArtifact(validated, {
          sourceName,
          driveFileId: sourceDriveFileId,
        })
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
      setError(privateMode ? "This private conversation map cannot be displayed. Return to your files and try another copy." : String(e?.message || e));
    }
  }, [privateMode]);

  useEffect(() => {
    if (!privateMode) return;
    ingest(privateBundle, { remember: false });
    setSrcLoading(false);
    setLibraryStatus({ state: "private", message: "Private cloud copy · edits stay in this view" });
  }, [privateMode, privateBundle, ingest]);

  const ingestPublic = useCallback((data) => {
    ingest(data, { remember: false });
    setSrcLoading(false);
    setLibraryStatus({ state: "public", message: "Public copy · edits stay in this view" });
  }, [ingest]);
  useEffect(() => { if (publicId && !privateMode) { setBundle(null); setError(""); setLibraryStatus(null); } }, [publicId, privateMode]);

  // A Drive link is stable, while its short-lived OAuth token is deliberately
  // not. Reopen the validated artifact already saved for this exact Drive file
  // before mounting Google authorization. Explicit Refresh remains the only
  // operation that contacts Drive again.
  useEffect(() => {
    if (privateMode || publicId || !driveFileId || artifactId || location.state?.threadsBundle || driveRefreshRequested) return;
    let cancelled = false;
    setSrcLoading(true);
    void getThreadsLibraryRecordByDriveFileId(driveFileId)
      .then((record) => {
        if (cancelled || !record) return;
        ingest(record.bundle, {
          sourceName: record.sourceName,
          driveFileId,
          remember: false,
        });
        setLibraryStatus({ state: "saved", message: "Saved on this device", recordId: record.id });
      })
      .catch((storageError) => {
        // Storage denial/corruption must not strand a valid Drive link. The
        // existing Google authorization gate is the recoverable fallback.
        console.warn("[ThreadsViewer] Could not reopen Drive artifact from this device:", storageError);
      })
      .finally(() => {
        if (!cancelled) setSrcLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [privateMode, artifactId, publicId, driveFileId, driveRefreshRequested, ingest, location.state]);

  const handleFile = useCallback(
    async (file) => {
      if (privateMode || !file) return;
      try {
        const data = await readThreadsFile(file);
        ingest(data, { sourceName: file.name });
      } catch (e) {
        setBundle(null);
        setError(`Could not read .threads file: ${String(e?.message || e)}`);
      }
    },
    [privateMode, ingest],
  );

  // Browse passes a parsed bundle through router state so the file opens even
  // when persistent browser storage is unavailable. Generated results explicitly
  // opt out of remembering; ordinary imported files keep the shared remember step.
  useEffect(() => {
    const routedBundle = generatedBundle || location.state?.threadsBundle;
    if (privateMode || publicId || consumedRouteState.current || (!routedBundle && !generatedMapId)) return;
    consumedRouteState.current = true;
    if (!routedBundle) {
      setError("This generated map is no longer available in this page. Open a downloaded .threads copy or generate another map.");
      setSrcLoading(false);
      return;
    }
    ingest(routedBundle, { sourceName: location.state?.sourceName || "", remember: !ephemeral });
    releaseGeneratedMap(generatedMapId);
    if (ephemeral) setLibraryStatus({ state: "memory", message: "Generated map · not saved" });
    setSrcLoading(false);
  }, [ingest, privateMode, publicId, ephemeral, generatedMapId, generatedBundle, location.state]);

  // Stable browser-local deep link used by Browse's "On this device" rows.
  useEffect(() => {
    if (privateMode || ephemeral || !artifactId) return;
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
  }, [privateMode, ephemeral, artifactId, ingest]);

  // Optional ?src=<url> — fetch a hosted .threads (NOT an /api/ call). Lets a
  // share be a plain link to a hosted file without any backend.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (privateMode || publicId || artifactId || location.state?.threadsBundle) return;
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
  }, [privateMode, artifactId, publicId, dataProvider, ingest, location.state]);

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
      ? withThreadLanes(enrichGraphNodesWithProvenance(indexExplicitEdges(
        flattenThreadsGraph(bundle.graph_data),
        bundle.edges,
        true,
      ), bundle.utterances || []), bundle.conversation_threads || [])
      : []),
    [bundle],
  );
  const speakerColorMap = useMemo(() => buildSpeakerColorMapForNodes(flatNodes), [flatNodes]);
  const findGroups = useMemo(() => buildViewerFindGroups(flatNodes), [flatNodes]);
  const onFindNode = useCallback((id) => {
    setViewMode("discussion");
    setMobileMapOpen(false);
    setDiscussionFocus((previous) => ({ id, requestKey: (previous?.requestKey || 0) + 1 }));
  }, []);
  const discussionLinkBase = useMemo(() => {
    if (privateMode || ephemeral || typeof window === "undefined") return null;
    const url = new URL(location.pathname + location.search, window.location.origin);
    if (publicId || artifactId || url.searchParams.has("src") || url.searchParams.has("driveFile")) return url.href;
    if (!libraryStatus?.recordId) return null;
    url.pathname = `/view/${encodeURIComponent(libraryStatus.recordId)}`;
    url.search = "";
    url.hash = "";
    return url.href;
  }, [privateMode, ephemeral, artifactId, publicId, libraryStatus?.recordId, location.pathname, location.search]);
  // Diagnostic (cold-open blank-graph investigation): confirms MinimalGraph
  // mounts only AFTER the .threads bundle is present, with a non-empty node
  // count — distinguishes the data-ready path (blank => camera) from a
  // data-arrival race. Toggle off with window.__MG_DEBUG__ = false.
  useEffect(() => {
    if (!privateMode && !ephemeral && typeof window !== "undefined" && (window.__MG_DEBUG__ ?? true)) {
      console.log("[ThreadsViewer] bundle ready -> MinimalGraph", { graphDataLen: (bundle?.graph_data || []).length, flatNodes: flatNodes.length });
    }
  }, [privateMode, ephemeral, bundle, flatNodes.length]);
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

  const downloadMap = useCallback(() => {
    if (!bundle) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `recording-${String(bundle.conversation_id || "map").replace(/[^a-z0-9_-]/gi, "-").slice(0, 80)}.threads`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }, [bundle]);

  const openLibrary = useCallback(() => privateMode ? onPrivateClose() : navigate(publicId ? "/public" : "/browse"), [privateMode, onPrivateClose, navigate, publicId]);
  const renameSpeaker = useCallback((speakerId, name) => {
    const updated = renameArtifactSpeaker(bundle, speakerId, name);
    setBundle(updated);
    if (privateMode) { setLibraryStatus({ state: "private", message: "Speaker names changed in this view only" }); return; }
    if (publicId) { setLibraryStatus({ state: "public", message: "Speaker names changed in this view only" }); return; }
    if (ephemeral) { setLibraryStatus({ state: "memory", message: "Speaker names changed in this view only · not saved" }); return; }
    setLibraryStatus({ state: "saving", message: "Saving speaker names…" });
    void rememberThreadsArtifact(updated).then((record) => {
      setLibraryStatus({ state: "saved", message: "Speaker names saved on this device", recordId: record.id });
    }).catch(() => setLibraryStatus({ state: "error", message: "Names changed here but could not be saved. Download the reviewed file." }));
  }, [bundle, publicId, privateMode, ephemeral]);
  const openAnother = useCallback(() => {
    if (privateMode) { onPrivateClose(); return; }
    setBundle(null);
    setError("");
    setLibraryStatus(null);
    setMobileMapOpen(false);
    navigate("/view");
  }, [privateMode, onPrivateClose, navigate]);

  if (privateMode && !bundle && !srcLoading) return <main className="min-h-dvh bg-[#fdfdfb] p-6 font-sans text-slate-800"><p role="alert" className="max-w-[65ch] text-sm leading-6">{error || "This private conversation map cannot be displayed."}</p><button type="button" className="mt-5 min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm" onClick={onPrivateClose}>Back to private files</button></main>;
  if (!privateMode && publicId && !bundle) return <PublicThreadsLoader key={publicId} id={publicId} onArtifact={ingestPublic} />;

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
  if (!bundle || driveRefreshRequested) {
    if (driveFileId) {
      return (
        <DriveOpener
          fileId={driveFileId}
          refreshing={driveRefreshRequested}
          onCancel={driveRefreshRequested ? () => setDriveRefreshRequested(false) : undefined}
          onArtifact={(artifact, options) => {
            ingest(artifact, options);
            setDriveRefreshRequested(false);
          }}
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
  const hasThreads = Array.isArray(bundle.conversation_threads) && bundle.conversation_threads.length > 0;
  const refreshFromDrive = !publicId && driveFileId ? () => setDriveRefreshRequested(true) : undefined;
  const sourceNotice = privateMode
    ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 border-b border-slate-200 bg-slate-100 px-4 text-sm text-slate-700"><span>Private cloud copy · edits stay in this view</span><button type="button" onClick={onPrivateClose} className="min-h-11 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700">Close private conversation</button></div>
    : ephemeral ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 border-b border-slate-200 bg-slate-100 px-4 text-sm text-slate-700"><span>Generated map · kept in this view · not saved</span><button type="button" className="min-h-11 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={downloadMap}>Download map</button></div>
      : publicId && <div className="shrink-0 border-b border-slate-200 bg-amber-50 px-4 py-2 text-xs text-slate-700">Public copy · visible to everyone · edits stay in this view</div>;
  const renderedViewMode = !compactViewer && viewMode === "cards" ? "graph" : viewMode;
  const toolbar = <ThreadsViewerToolbar
    viewMode={renderedViewMode} modes={["graph", "discussion", ...(compactViewer ? ["cards"] : [])]}
    onViewModeChange={(mode) => { setViewMode(mode); setMobileMapOpen(mode === "graph"); }}
    graphToolsRef={setGraphToolsHost} graphTierRef={setGraphTierHost} findGroups={findGroups} onFindNode={onFindNode}
    overviewAvailable={Boolean(bundle.executive_summary || focusNode?.summary)} overviewOpen={overviewOpen} onToggleOverview={() => setOverviewOpen((value) => !value)}
    sourceAvailable={Boolean(selectYouTubeRef(bundle) || bundle.media_refs?.some((ref) => ref?.provider === "youtube"))} sourceOpen={sourceOpen} onToggleSource={() => setSourceOpen((value) => !value)}
    timelineAvailable={flatNodes.length > 0} timelineOpen={timelineOpen} onToggleTimeline={() => setTimelineOpen((value) => !value)}
    onDownloadTranscript={downloadTranscript}
    onEnterFocus={() => { if (renderedViewMode === "discussion") setViewMode("graph"); setSourceOpen(false); setMobileMapOpen(false); setFocusMode(true); }}
    onOpenLibrary={openLibrary} onOpenAnother={openAnother} onRefreshFromDrive={refreshFromDrive}
    cardSettings={<CardDisplaySettings />} libraryStatus={libraryStatus} coverage={bundle.coverage}
  />;
  const viewControls = <div role="group" aria-label="Conversation view" className="flex shrink-0 gap-1 border-b border-slate-200 bg-white px-3 py-1">
    {["graph", "discussion", ...(compactViewer ? ["cards"] : [])].map((mode) => <button key={mode} type="button"
      aria-pressed={viewMode === mode} onClick={() => { setViewMode(mode); setMobileMapOpen(mode === "graph"); }}
      className={`min-h-11 rounded-md px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 ${viewMode === mode ? "bg-slate-800 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
      {mode[0].toUpperCase() + mode.slice(1)}</button>)}
  </div>;
  if (viewMode === "discussion") return <div className="flex h-[100dvh] w-full max-w-full min-h-0 flex-col overflow-hidden">
    {sourceNotice}
    <ThreadsViewerHeader bundle={bundle} focusNode={focusNode} libraryStatus={libraryStatus} overviewOpen={overviewOpen} />
    {toolbar}
    <div className={`flex min-h-0 min-w-0 flex-1 ${narrowViewer ? "flex-col" : ""}`}>
      {sourceOpen && <YouTubeSourcePanel bundle={bundle} nodes={flatNodes} compact={narrowViewer} onRenameSpeaker={renameSpeaker} onClose={() => setSourceOpen(false)} />}
      <div className="min-h-0 min-w-0 flex-1"><DiscussionView nodes={flatNodes} utterances={bundle.utterances || []} speakerColorMap={speakerColorMap} onRenameSpeaker={renameSpeaker} focusRequest={discussionFocus} linkBase={discussionLinkBase} namesStayInView={privateMode || ephemeral || Boolean(publicId)} /></div>
    </div>
    {flatNodes.length > 0 && <TimelineRibbon graphData={flatNodes} selectedNode={discussionFocus?.id}
      setSelectedNode={(value) => setDiscussionFocus((previous) => {
        const id = typeof value === "function" ? value(previous?.id) : value;
        return id ? { id, requestKey: (previous?.requestKey || 0) + 1 } : previous;
      })}
      semanticLevel={hasThreads ? 1 : visibleGraphLevel} expanded={timelineOpen} onExpandedChange={setTimelineOpen} />}
  </div>;
  if (compactViewer && viewMode === "cards") {
    return (
      <div className="flex h-[100dvh] min-h-0 flex-col">{sourceNotice}{viewControls}<div className="min-h-0 flex-1 [&>div]:h-full"><MobileConversationDeck
        bundle={bundle}
        deckState={mobileDeckState}
        readingPath={mobileReadingPath}
        onReadingPathChange={setMobileReadingPath}
        graphNodes={flatNodes}
        libraryStatus={libraryStatus}
        onDeckStateChange={setMobileDeckState}
        onDownloadTranscript={downloadTranscript}
        onOpenLibrary={openLibrary}
        onRefreshFromDrive={refreshFromDrive}
        onOpenAnother={openAnother}
        onShowMap={(id) => {requestMapTarget(id);setMobileMapOpen(true);setViewMode("graph");}}
        onRenameSpeaker={renameSpeaker}
      /></div></div>
    );
  }

  const viewerFocusMode = focusMode || (compactViewer && mobileMapOpen);
  return (
    <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-[#fafafa] font-sans">
      {sourceNotice}
      {!focusMode && (!compactViewer || !mobileMapOpen || overviewOpen) && (
        <ThreadsViewerHeader
          bundle={bundle}
          focusNode={focusNode}
          libraryStatus={libraryStatus}
          overviewOpen={overviewOpen}
        />
      )}

      {!focusMode && toolbar}
      <div className={`flex min-h-0 min-w-0 flex-1 ${narrowViewer ? "flex-col" : ""}`}>
        {sourceOpen && <YouTubeSourcePanel bundle={bundle} node={selectedNodeData || flatNodes.find((n) => String(n.id) === String(mediaNode))} nodes={flatNodes} compact={narrowViewer} onRenameSpeaker={renameSpeaker} seekRequest={sourceSeek} onSeekHandled={sourceSeekHandled} onClose={() => setSourceOpen(false)} />}
      <div className="relative min-h-0 min-w-0 flex-1">
        <MinimalGraph
          diagnosticsEnabled={!privateMode && !ephemeral}
          graphData={flatNodes}
          semanticEdges={bundle.edges}
          focusNode={mapTarget}
          focusRequestKey={mapRequest}
          semanticZoom={false}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          onVisibleLevelChange={(view) => {
            if (!privateMode && !ephemeral && typeof window !== "undefined" && (window.__MG_DEBUG__ ?? true)) {
              console.log("[ThreadsViewer] onVisibleLevelChange", { mode: view?.mode, level: view?.level, label: view?.label, ribbonLevel: view?.mode === "semantic" ? view.level : null });
            }
            setVisibleGraphLevel(view?.mode === "semantic" ? view.level : null);
          }}
          onFocusChange={setFocusNode}
          onActiveNodeChange={setMediaNode}
          chromeless={focusMode}
          argumentTraceFrom={argumentTraceFrom}
          setArgumentTraceFrom={setArgumentTraceFrom}
          toolbarTarget={graphToolsHost}
          toolbarTierTarget={graphTierHost}
          toolbarMode
          hideWeaknessLenses
        />
        {compactViewer && mobileMapOpen && (
          <button
            type="button"
            onClick={() => {
              const target=selectedNode || mediaNode || mapTarget;
              const next=target && mobileDeckStateForNode(buildMobileConversationDeck(flatNodes,bundle.utterances || []),target);
              if(next) setMobileDeckState(next);
              setMobileMapOpen(false);
              setViewMode("cards");
            }}
            title="Return to conversation cards"
            aria-label="Return to conversation cards"
            className="absolute right-3 bottom-3 z-50 inline-flex h-12 items-center gap-1.5 rounded-full border border-slate-200 bg-white/90 px-3 text-[11px] font-medium text-slate-600 shadow-sm backdrop-blur hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Rows3 aria-hidden="true" className="h-4 w-4" />
            Cards
          </button>
        )}
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
        {!viewerFocusMode && <MinimalLegend speakerColorMap={speakerColorMap} />}
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
            onSeekMedia={!compactViewer && selectYouTubeRef(bundle) ? seconds => setSourceSeek({seconds,videoId:selectYouTubeRef(bundle).video_id}) : undefined}
            contextNodes={flatNodes}
            onSelectNode={(id)=>{requestMapTarget(id);setSelectedNode(id);}}
            onClose={() => setSelectedNode(null)}
            onTraceAncestors={setArgumentTraceFrom}
          />
        )}
      </div>
      </div>

      {!focusMode && flatNodes.length > 0 && (
        <TimelineRibbon
          graphData={flatNodes}
          selectedNode={selectedNode || mediaNode || mapTarget}
          setSelectedNode={(value)=>{
            const id = typeof value === "function" ? value(selectedNode || mediaNode || mapTarget) : value;
            if (!id) return;
            requestMapTarget(id); setSelectedNode(id); setMediaNode(id);
          }}
          semanticLevel={hasThreads ? 1 : visibleGraphLevel}
          expanded={timelineOpen}
          onExpandedChange={setTimelineOpen}
        />
      )}
    </div>
  );
}

ThreadsViewer.propTypes = { privateBundle: PropTypes.object, onPrivateClose: PropTypes.func };
ThreadsViewerContent.propTypes = ThreadsViewer.propTypes;
