import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import MinimalGraph from "../components/MinimalGraph";
import SessionTranscriptOverlay from "../components/transcript/SessionTranscriptOverlay";
import { wsUrl, sendWsAuth } from "../services/apiClient";
import { createBackendMessageHandler } from "../components/audio/audioMessages";
import { upsertLiveTranscriptLine } from "../components/transcript/liveTranscriptLines";
import { normalizeGraphDataPayload, applyGraphPatch } from "./newConversationGraphState";

/**
 * Read-only live viewer for a meeting bot. Subscribes to /ws/meeting/:id, which
 * relays the EXACT same protocol the recording path emits (existing_json /
 * graph_patch / session_started), so the graph builds in real time using the
 * shared graph-patch appliers + MinimalGraph — no meeting-specific graph code.
 */

const STATUS_LABELS = {
  starting: "Starting…",
  joining: "Bot joining…",
  waiting_room: "Waiting room — admit the bot",
  recording: "Recording",
  finalizing: "Wrapping up…",
  ended: "Meeting ended",
  error: "Connection error",
};

const STATUS_STYLES = {
  recording: "bg-emerald-50 border-emerald-300 text-emerald-700",
  joining: "bg-amber-50 border-amber-300 text-amber-700",
  waiting_room: "bg-amber-50 border-amber-300 text-amber-700",
  starting: "bg-slate-50 border-slate-300 text-slate-600",
  finalizing: "bg-sky-50 border-sky-300 text-sky-700",
  ended: "bg-slate-100 border-slate-300 text-slate-600",
  error: "bg-rose-50 border-rose-300 text-rose-700",
};

export default function MeetingView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [graphData, setGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [status, setStatus] = useState("starting");
  const [botState, setBotState] = useState(null);
  const [error, setError] = useState("");
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [transcriptMinimized, setTranscriptMinimized] = useState(true);

  const graphFromSocketRef = useRef(false);
  const flushResolveRef = useRef(null);
  const transcriptLineIdRef = useRef(1);

  useEffect(() => {
    if (!conversationId) return undefined;
    let ws;

    const handler = createBackendMessageHandler({
      graphDataFromSocket: graphFromSocketRef,
      flushResolveRef,
      onDataReceived: (data) => setGraphData(normalizeGraphDataPayload(data) || []),
      onGraphPatchReceived: (patch) => setGraphData((prev) => applyGraphPatch(prev, patch)),
      onTranscriptEvent: (event) => {
        setTranscriptLines((previous) =>
          upsertLiveTranscriptLine(previous, event, transcriptLineIdRef)
        );
      },
      onBackendMessage: (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "bot_status") {
          if (message.data?.status) setStatus(message.data.status);
          if (message.data?.bot_state) setBotState(message.data.bot_state);
        } else if (message.type === "meeting_ended") {
          setStatus((s) => (s === "error" ? s : "ended"));
        } else if (message.type === "error") {
          setError(String(message.detail || "Backend error"));
        }
      },
    });

    try {
      ws = new WebSocket(wsUrl(`/ws/meeting/${conversationId}`));
    } catch (e) {
      setError(`Could not open viewer socket: ${e}`);
      return undefined;
    }
    ws.onopen = () => sendWsAuth(ws);
    ws.onmessage = handler;

    return () => {
      try {
        if (ws) ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [conversationId]);

  const hasData = Array.isArray(graphData) && graphData.some((c) => Array.isArray(c) && c.length);
  const statusLabel = STATUS_LABELS[status] || status;
  const statusStyle = STATUS_STYLES[status] || STATUS_STYLES.starting;
  const transcriptOverlayVisible = transcriptLines.length > 0;
  const viewportBottom = transcriptOverlayVisible ? (transcriptMinimized ? "4.5rem" : "40%") : "0";

  return (
    <div className="relative flex h-[100dvh] w-screen flex-col bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)]">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white/70 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
            title="Home"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="text-sm font-medium text-slate-700">Live Meeting Graph</span>
        </div>
        <div className="flex items-center gap-3">
          <div className={`rounded-full border px-3 py-1 text-xs font-medium ${statusStyle}`}>
            {status === "recording" && (
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle" />
            )}
            {statusLabel}
            {botState ? ` · ${botState}` : ""}
          </div>
          <button
            onClick={() => navigate(`/conversation/${conversationId}`)}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
            title="Open the saved conversation"
          >
            Saved view
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      <main className="relative flex-1 overflow-hidden">
        <div
          className="absolute inset-x-0 top-0 transition-[bottom] duration-300"
          style={{ bottom: viewportBottom }}
        >
          {hasData ? (
            <MinimalGraph
              graphData={graphData}
              selectedNode={selectedNode}
              setSelectedNode={setSelectedNode}
              conversationId={conversationId}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-500">
              {status !== "ended" && status !== "error" && (
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
              )}
              <p className="text-sm">
                {status === "ended"
                  ? "Meeting ended — no graph was produced yet."
                  : status === "error"
                  ? "Couldn't attach to this meeting."
                  : "Waiting for the bot to join and start transcribing…"}
              </p>
              <p className="text-xs text-slate-400">The graph builds itself as people speak.</p>
            </div>
          )}
        </div>
        {transcriptOverlayVisible && (
          <div>
            <SessionTranscriptOverlay
              hasData={hasData}
              minimized={transcriptMinimized}
              onExpand={() => setTranscriptMinimized(false)}
              onMinimize={() => setTranscriptMinimized(true)}
              lines={transcriptLines}
              mode="live"
              statusText="Meeting transcript"
            />
          </div>
        )}
      </main>
    </div>
  );
}
