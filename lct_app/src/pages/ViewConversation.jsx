import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Download } from "lucide-react";

import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import TimelineRibbon from "../components/TimelineRibbon";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { apiFetch, apiFetchCached, API_BASE_URL } from "../services/apiClient";

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

async function readErrorMessage(response) {
  let message = `Request failed with status ${response.status}`;

  try {
    const payload = await response.json();
    if (payload?.detail && typeof payload.detail === "string") {
      message = payload.detail;
    } else if (payload?.message && typeof payload.message === "string") {
      message = payload.message;
    }
  } catch {
    // keep fallback message when response is not json
  }

  return message;
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

  const allNodes = useMemo(
    () => graphData.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [])),
    [graphData]
  );

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
        </div>

        <div className="flex shrink-0 items-center gap-3">
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
            <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-500">
              {allNodes.length} nodes
            </span>
          )}
        </div>
      </header>

      {executiveSummary && summaryExpanded && (
        <div className="shrink-0 border-b border-slate-200 bg-white/70 px-6 py-3 text-xs leading-relaxed text-slate-600 backdrop-blur">
          {executiveSummary}
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
            audioUrl={audioDownloadUrl ? (audioDownloadUrl.startsWith("http") ? audioDownloadUrl : `${API_BASE_URL}${audioDownloadUrl}`) : null}
            onClose={() => setSelectedNode(null)}
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
    </div>
  );
}
