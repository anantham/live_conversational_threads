import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle, Download, FileJson, Map, Share2, XCircle } from "lucide-react";
import ShareManagerModal from "../components/share/ShareManagerModal";
import AnalyzeMenu from "../components/AnalyzeMenu";

import {
  buildConversationDebugExport,
  downloadConversationDebugExport,
} from "../components/audio/exportSessionDebug";
import { fetchConversationObservability } from "../services/conversationDiagnosticsApi";

import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import SearchDialog from "../components/SearchDialog";
import TimelineRibbon from "../components/TimelineRibbon";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { apiFetch, apiFetchCached, apiHeaders, API_BASE_URL, readErrorMessage } from "../services/apiClient";
import { fetchConversationParticipants } from "../services/participantsApi";

function sanitizeNodeArray(chunk) {
  return (Array.isArray(chunk) ? chunk : []).filter(
    (item) => item && typeof item === "object" && !Array.isArray(item)
  );
}

function unwrapGraphPayload(payload) {
  const unwrapObject = (candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    if (Array.isArray(candidate.existing_json)) return candidate.existing_json;
    if (Array.isArray(candidate.data)) return candidate.data;
    return candidate;
  };

  let candidate = unwrapObject(payload);

  if (
    Array.isArray(candidate) &&
    candidate.length === 1 &&
    candidate[0] &&
    typeof candidate[0] === "object" &&
    !Array.isArray(candidate[0])
  ) {
    candidate = unwrapObject(candidate[0]);
  }

  return candidate;
}

function normalizeGraphDataPayload(payload) {
  const unwrapped = unwrapGraphPayload(payload);
  if (!Array.isArray(unwrapped)) {
    return [];
  }

  if (unwrapped.length === 0) {
    return [];
  }

  if (Array.isArray(unwrapped[0])) {
    return unwrapped.map(sanitizeNodeArray).filter((chunk) => chunk.length > 0);
  }

  if (unwrapped[0] && typeof unwrapped[0] === "object") {
    const chunkOrder = [];
    const chunkMap = new Map();

    unwrapped.forEach((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }

      const chunkId =
        typeof node.chunk_id === "string" && node.chunk_id.trim() ? node.chunk_id : "chunk-0";

      if (!chunkMap.has(chunkId)) {
        chunkMap.set(chunkId, []);
        chunkOrder.push(chunkId);
      }

      chunkMap.get(chunkId).push(node);
    });

    return chunkOrder.map((chunkId) => chunkMap.get(chunkId)).filter((chunk) => chunk.length > 0);
  }

  return [];
}

export default function ViewConversation() {
  const { conversationId } = useParams();
  const navigate = useNavigate();

  const [graphData, setGraphData] = useState([]);
  const [chunkDict, setChunkDict] = useState({});
  const [conversationName, setConversationName] = useState("");
  const [conversationTitle, setConversationTitle] = useState("");
  const [executiveSummary, setExecutiveSummary] = useState("");
  const [summaryExpanded, setSummaryExpanded] = useState(true);
  const [selectedNode, setSelectedNode] = useState(null);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [speakerRefreshKey, setSpeakerRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [audioDownloadUrl, setAudioDownloadUrl] = useState("");
  const [participants, setParticipants] = useState([]);
  // ADR-032 Part B pattern 3: argument-scaffold trace lifted to page so
  // NodeDetail's "Trace ancestors" button can trigger it and MinimalGraph
  // can dim accordingly.
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);
  // ADR-032 Part K: Cmd+K / "/" opens search.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "/" && !event.target?.matches?.("input, textarea, [contenteditable]")) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const allFlatNodes = useMemo(() => {
    const out = [];
    (graphData || []).forEach((chunk) => {
      if (Array.isArray(chunk)) {
        chunk.forEach((node) => {
          if (node && typeof node === "object" && !Array.isArray(node)) out.push(node);
        });
      }
    });
    return out;
  }, [graphData]);

  useEffect(() => {
    if (!conversationId) {
      setIsLoading(false);
      setLoadError("Missing conversation id.");
      return;
    }

    let isCancelled = false;

    async function loadConversation() {
      setIsLoading(true);
      setLoadError("");
      setSelectedNode(null);

      try {
        // 5-minute TTL: a conversation's graph_data changes rarely (only on
        // re-import or refinement). Instant nav-back is a huge UX win.
        const conversationResponse = await apiFetchCached(
          `/conversations/${conversationId}`,
          { ttlMs: 5 * 60 * 1000 },
        );
        if (!conversationResponse.ok) {
          throw new Error(await readErrorMessage(conversationResponse));
        }

        const payload = await conversationResponse.json();
        if (isCancelled) return;

        setGraphData(normalizeGraphDataPayload(payload.graph_data));
        setChunkDict(
          payload.chunk_dict && typeof payload.chunk_dict === "object" && !Array.isArray(payload.chunk_dict)
            ? payload.chunk_dict
            : {}
        );
        // A7: LLM-authored title + 3-sentence executive summary from the
        // arcs consolidation pass. Empty for legacy conversations that
        // pre-date the consolidation pipeline.
        if (typeof payload.conversation_title === "string" && payload.conversation_title.trim()) {
          setConversationTitle(payload.conversation_title.trim());
        }
        if (typeof payload.executive_summary === "string" && payload.executive_summary.trim()) {
          setExecutiveSummary(payload.executive_summary.trim());
        }

        // Audio status changes only when the user re-imports or finishes a
        // live recording — cache 5 min, same as the conversation payload.
        try {
          const audioStatusResponse = await apiFetchCached(
            `/api/conversations/${conversationId}/audio/status`,
            { ttlMs: 5 * 60 * 1000 },
          );
          if (audioStatusResponse.ok) {
            const audioStatus = await audioStatusResponse.json();
            if (!isCancelled && audioStatus.download_url) {
              setAudioDownloadUrl(audioStatus.download_url);
            }
          }
        } catch {
          // audio status lookup is optional
        }

        // List is mostly stable but can grow on new imports. 60s is short
        // enough that revisiting after a new upload sees it; the import
        // success path calls invalidateApiCache('/conversations/') anyway.
        try {
          const listResponse = await apiFetchCached("/conversations/", { ttlMs: 60 * 1000 });
          if (listResponse.ok) {
            const conversations = await listResponse.json();
            if (!isCancelled && Array.isArray(conversations)) {
              const match = conversations.find((item) => item?.file_id === conversationId);
              if (match?.file_name) {
                setConversationName(match.file_name);
              }
            }
          }
        } catch {
          // metadata lookup is optional for this view
        }
      } catch (error) {
        if (isCancelled) return;
        setLoadError(error?.message || "Failed to load conversation.");
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadConversation();

    return () => {
      isCancelled = true;
    };
  }, [conversationId]);

  // Participants are a separate concern from the graph payload, so we fetch
  // independently — a 404 / empty list shouldn't fail the whole view. Legacy
  // conversations recorded before the picker shipped just render no chips.
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    fetchConversationParticipants(conversationId).then((rows) => {
      if (!cancelled) setParticipants(Array.isArray(rows) ? rows : []);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Decision-B: pending transcript revisions (slow-pass proposed, awaiting operator review).
  const [pendingRevisions, setPendingRevisions] = useState([]);
  const [revisionActionState, setRevisionActionState] = useState({ busy: false, error: "" });
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    apiFetch(`/conversations/${conversationId}/revisions`)
      .then((r) => r.ok ? r.json() : { revisions: [] })
      .then((data) => {
        if (!cancelled) setPendingRevisions(data.revisions || []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId]);

  const handleRevisionApprove = useCallback(async (revisionId) => {
    if (revisionActionState.busy) return;
    setRevisionActionState({ busy: true, error: "" });
    try {
      const resp = await fetch(
        `${API_BASE_URL}/api/conversations/${conversationId}/revisions/${revisionId}/approve`,
        { method: "POST", headers: apiHeaders() },
      );
      if (!resp.ok) {
        const msg = await readErrorMessage(resp);
        setRevisionActionState({ busy: false, error: msg || "Approval failed." });
        return;
      }
      const data = await resp.json();
      // Mark the revision gone locally; caller should also POST to data.next to re-run.
      setPendingRevisions((prev) => prev.filter((r) => r.id !== revisionId));
      setRevisionActionState({ busy: false, error: "" });
      // Fire-and-forget the reprocess to apply the approved transcript.
      if (data.next) {
        fetch(`${API_BASE_URL}${data.next}`, { method: "POST", headers: apiHeaders() }).catch(() => {});
      }
    } catch (err) {
      setRevisionActionState({ busy: false, error: err?.message || "Approval failed." });
    }
  }, [conversationId, revisionActionState.busy]);

  const handleRevisionReject = useCallback(async (revisionId) => {
    if (revisionActionState.busy) return;
    setRevisionActionState({ busy: true, error: "" });
    try {
      const resp = await fetch(
        `${API_BASE_URL}/api/conversations/${conversationId}/revisions/${revisionId}/reject`,
        { method: "POST", headers: apiHeaders() },
      );
      if (!resp.ok) {
        const msg = await readErrorMessage(resp);
        setRevisionActionState({ busy: false, error: msg || "Rejection failed." });
        return;
      }
      setPendingRevisions((prev) => prev.filter((r) => r.id !== revisionId));
      setRevisionActionState({ busy: false, error: "" });
    } catch (err) {
      setRevisionActionState({ busy: false, error: err?.message || "Rejection failed." });
    }
  }, [conversationId, revisionActionState.busy]);

  const allNodes = useMemo(
    () => graphData.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [])),
    [graphData]
  );

  // Download the conversation as a JSON debug bundle. Uses the same
  // exportSessionDebug helpers as the legacy NewConversation export, but
  // populates only the fields that exist for a saved conversation —
  // there's no draft state, no live audio session, no live transcript
  // lines. Backend observability is best-effort: failure to fetch it
  // still produces a usable export.
  const [exportBusy, setExportBusy] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const handleExportJson = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    let backendObservability = {};
    try {
      backendObservability = conversationId
        ? await fetchConversationObservability(conversationId)
        : {};
    } catch (error) {
      console.warn("[ViewConversation] backend observability fetch failed:", error);
    }
    const payload = buildConversationDebugExport({
      conversationId,
      fileName: conversationName || conversationTitle || conversationId,
      message: "",
      graphData,
      draftGraphData: [],
      chunkDict,
      draftChunkDict: {},
      audioRecovery: null,
      audioSession: null,
      backendObservability,
    });
    downloadConversationDebugExport(
      payload,
      conversationId,
      conversationName || conversationTitle || conversationId,
    );
    setExportBusy(false);
  }, [
    chunkDict,
    conversationId,
    conversationName,
    conversationTitle,
    exportBusy,
    graphData,
  ]);

  // Export the conversation as a self-contained .threads artifact (ADR-036):
  // the owner downloads the file and shares it directly; the recipient opens it
  // at /view (static, server-free). apiFetch carries AUTH_TOKEN.
  const [threadsBusy, setThreadsBusy] = useState(false);
  const handleExportThreads = useCallback(async () => {
    if (threadsBusy || !conversationId) return;
    setThreadsBusy(true);
    try {
      const resp = await apiFetch(`/api/conversations/${conversationId}/threads-export`);
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`);
      const blob = await resp.blob();
      const safe =
        (conversationTitle || conversationName || conversationId || "conversation")
          .replace(/[^a-z0-9-_ ]/gi, "_")
          .slice(0, 60)
          .trim() || "conversation";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe}.threads`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("[ViewConversation] .threads export failed:", error);
    } finally {
      setThreadsBusy(false);
    }
  }, [threadsBusy, conversationId, conversationName, conversationTitle]);

  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return allNodes.find((node) => node?.id === selectedNode) || null;
  }, [allNodes, selectedNode]);
  const graphViewportKey = selectedNodeData ? "detail-open" : "detail-closed";

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(allNodes), [allNodes]);

  useEffect(() => {
    if (!selectedNode) return;
    if (!allNodes.some((node) => node?.id === selectedNode)) {
      setSelectedNode(null);
    }
  }, [allNodes, selectedNode]);

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#f2f1ed] text-slate-800">
      <header className="flex shrink-0 items-center border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur">
        <button
          onClick={() => navigate("/browse")}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Back
        </button>

        <div className="min-w-0 flex-1 px-4">
          <h1
            className="truncate text-sm font-semibold text-slate-800"
            title={conversationTitle || conversationName || conversationId || "Conversation"}
          >
            {conversationTitle || conversationName || conversationId || "Conversation"}
          </h1>
          <p className="text-xs text-slate-500">
            {executiveSummary ? (
              <button
                type="button"
                onClick={() => setSummaryExpanded((v) => !v)}
                className="text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
              >
                {summaryExpanded ? "Hide executive summary" : "Show executive summary"}
              </button>
            ) : (
              "Saved conversation view"
            )}
          </p>
          {participants.length > 0 ? (
            <div
              className="mt-1 flex flex-wrap items-center gap-1"
              title={participants.map((p) => p.display_name).join(", ")}
            >
              {participants.map((p) => (
                <span
                  key={p.contact_id}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                >
                  {p.display_name}
                  {p.external_llm_ok === false ? (
                    <span
                      className="ml-1 text-amber-600"
                      title="Voice clip stays local (privacy tier)"
                    >
                      •
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {allNodes.length > 0 && <AnalyzeMenu conversationId={conversationId} />}
          {audioDownloadUrl && (
            <a
              href={audioDownloadUrl.startsWith("http") ? audioDownloadUrl : `${API_BASE_URL}${audioDownloadUrl}`}
              className="flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors p-1"
              title="Download Audio"
            >
              <Download size={16} />
            </a>
          )}
          {allNodes.length > 0 && (
            <button
              type="button"
              onClick={handleExportJson}
              disabled={exportBusy}
              className="flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors p-1 disabled:cursor-wait disabled:opacity-50"
              title="Download graph + transcript as JSON"
              aria-label="Download conversation JSON"
            >
              <FileJson size={16} />
            </button>
          )}
          {allNodes.length > 0 && (
            <button
              type="button"
              onClick={handleExportThreads}
              disabled={threadsBusy}
              className="flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors p-1 disabled:cursor-wait disabled:opacity-50"
              title="Export a shareable .threads map (open it at /view — no server needed)"
              aria-label="Export .threads map"
            >
              <Map size={16} />
            </button>
          )}
          {allNodes.length > 0 && (
            <button
              type="button"
              onClick={() => setShareModalOpen(true)}
              className="flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors p-1"
              title="Share this conversation"
              aria-label="Share conversation"
            >
              <Share2 size={16} />
            </button>
          )}
          {allNodes.length > 0 && (
            <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-500">
              {allNodes.length} nodes
            </span>
          )}
        </div>
      </header>

      {pendingRevisions.length > 0 && pendingRevisions.map((rev) => (
        <div key={rev.id} className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[11px] text-amber-800">
              Revised transcript pending review — {rev.segment_count} segment{rev.segment_count !== 1 ? "s" : ""} from {rev.source}
              {rev.created_at ? ` (proposed ${new Date(rev.created_at).toLocaleString()})` : ""}
            </span>
            {revisionActionState.error && (
              <span className="text-[11px] text-red-600">{revisionActionState.error}</span>
            )}
            <button
              type="button"
              disabled={revisionActionState.busy}
              onClick={() => handleRevisionApprove(rev.id)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 disabled:cursor-wait"
              title="Apply this revised transcript and rebuild the graph"
            >
              <CheckCircle size={12} />
              Approve
            </button>
            <button
              type="button"
              disabled={revisionActionState.busy}
              onClick={() => handleRevisionReject(rev.id)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-wait"
              title="Dismiss this proposed revision without applying it"
            >
              <XCircle size={12} />
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {executiveSummary && summaryExpanded && (
        <div className="relative shrink-0 border-b border-slate-200 bg-white/70 px-6 py-3 pr-10 text-xs leading-relaxed text-slate-600 backdrop-blur">
          {executiveSummary}
          <button
            type="button"
            onClick={() => setSummaryExpanded(false)}
            className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
            title="Hide summary"
            aria-label="Hide executive summary"
          >
            <span className="text-base leading-none">×</span>
          </button>
        </div>
      )}

      <main className="relative min-h-0 flex-1">
        {isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Loading conversation...
          </div>
        )}

        {!isLoading && loadError && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-xl text-sm text-red-600">{loadError}</p>
            <button
              onClick={() => navigate("/browse")}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Return to browse
            </button>
          </div>
        )}

        {!isLoading && !loadError && allNodes.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
            This conversation has no graph nodes yet.
          </div>
        )}

        {!isLoading && !loadError && allNodes.length > 0 && (
          <div className="flex h-full flex-col">
            <div className="relative min-h-0 flex-1">
              <div
                className={`absolute inset-0 transition-all duration-200 ${
                  selectedNodeData ? "sm:right-80" : ""
                }`}
              >
                <MinimalGraph
                  graphData={graphData}
                  selectedNode={selectedNode}
                  setSelectedNode={setSelectedNode}
                  viewportReservationKey={graphViewportKey}
                  onVisibleLevelChange={(view) => {
                    setVisibleGraphLevel(view?.mode === "semantic" ? view.level : null);
                  }}
                  argumentTraceFrom={argumentTraceFrom}
                  setArgumentTraceFrom={setArgumentTraceFrom}
                />
                <MinimalLegend
                  speakerColorMap={speakerColorMap}
                  conversationId={conversationId}
                  refreshKey={speakerRefreshKey}
                />
              </div>
            </div>
            <TimelineRibbon
              graphData={graphData}
              selectedNode={selectedNode}
              setSelectedNode={setSelectedNode}
              semanticLevel={visibleGraphLevel}
            />
          </div>
        )}

        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={chunkDict}
            conversationId={conversationId}
            participantNames={participants.map((p) => p.display_name).filter(Boolean)}
            audioUrl={audioDownloadUrl ? (audioDownloadUrl.startsWith("http") ? audioDownloadUrl : `${API_BASE_URL}${audioDownloadUrl}`) : null}
            onClose={() => setSelectedNode(null)}
            onTraceAncestors={setArgumentTraceFrom}
            onSpeakerRenamed={(speakerId, newName) => {
              setGraphData((prev) =>
                prev.map((chunk) =>
                  Array.isArray(chunk)
                    ? chunk.map((node) =>
                        node.speaker_id === speakerId
                          ? { ...node, speaker_display: newName }
                          : node
                      )
                    : chunk
                )
              );
              setSpeakerRefreshKey((value) => value + 1);
            }}
          />
        )}
      </main>
      <SearchDialog
        open={searchOpen}
        nodes={allFlatNodes}
        onSelect={(nodeId) => setSelectedNode(nodeId)}
        onClose={() => setSearchOpen(false)}
      />
      {shareModalOpen && (
        <ShareManagerModal
          conversationId={conversationId}
          onClose={() => setShareModalOpen(false)}
        />
      )}
    </div>
  );
}
