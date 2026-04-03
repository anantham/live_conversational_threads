import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AudioInput from "../components/AudioInput";
import FileUpload from "../components/FileUpload";
import MinimalGraph from "../components/MinimalGraph";
import TimelineRibbon from "../components/TimelineRibbon";
import NodeDetail from "../components/NodeDetail";
import MinimalLegend from "../components/MinimalLegend";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { useAutoSave } from "../hooks/useAutoSave";
import { useUpload } from "../contexts/UploadContext";
import {
  applyChunkPatch,
  applyGraphPatch,
  mergeGraphLayers,
  normalizeGraphDataPayload,
  normalizeGraphPatchPayload,
} from "./newConversationGraphState";

export default function NewConversation() {
  const [graphData, setGraphData] = useState([]);
  const [draftGraphData, setDraftGraphData] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [chunkDict, setChunkDict] = useState({});
  const [draftChunkDict, setDraftChunkDict] = useState({});
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [transcriptMinimized, setTranscriptMinimized] = useState(false);
  const audioRef = useRef(null);

  const navigate = useNavigate();

  const displayGraphData = useMemo(
    () => mergeGraphLayers(graphData, draftGraphData),
    [draftGraphData, graphData]
  );
  const displayChunkDict = useMemo(
    () => ({ ...chunkDict, ...draftChunkDict }),
    [chunkDict, draftChunkDict]
  );

  // All nodes flattened (graph renders all chunks, not just the last one)
  const allNodes = useMemo(
    () => (displayGraphData || []).flat(),
    [displayGraphData]
  );

  const latestChunk = useMemo(
    () => displayGraphData?.[displayGraphData.length - 1] || [],
    [displayGraphData]
  );
  const hasData = allNodes.length > 0;
  const hasFinalizedData = (graphData?.[graphData.length - 1] || []).length > 0;

  const { saveStatus, lastSavedAt, triggerSave } = useAutoSave({
    conversationId,
    graphData,
    conversationName: fileName || undefined,
    enabled: hasFinalizedData,
  });

  // Resolve selected node data for detail panel — search all chunks
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return allNodes.find((n) => n.id === selectedNode) || null;
  }, [selectedNode, allNodes]);

  // Speaker color map (shared between graph, ribbon, legend)
  const speakerColorMap = useMemo(() => buildSpeakerColorMap(allNodes), [allNodes]);

  const handleDataReceived = useCallback((newData) => {
    const normalized = normalizeGraphDataPayload(newData);
    if (normalized === null) {
      console.warn(
        "[NewConversation] Ignoring malformed existing_json payload."
      );
      return;
    }
    if (normalized.length === 0) {
      setDraftGraphData([]);
      setDraftChunkDict({});
    }
    setGraphData(normalized);
  }, []);

  const handleChunksReceived = useCallback((chunks) => setChunkDict((prev) => ({ ...prev, ...chunks })), []);

  const handleGraphPatchReceived = useCallback((patchPayload) => {
    const patch = normalizeGraphPatchPayload(patchPayload);
    if (!patch) {
      console.warn("[NewConversation] Ignoring malformed graph_patch payload.");
      return;
    }

    const applyToDraftLayer = patch.kind === "draft" || patch.kind === "draft_clear";

    if (applyToDraftLayer) {
      setDraftGraphData((previous) => applyGraphPatch(previous, patch));
      setDraftChunkDict((previous) => applyChunkPatch(previous, patch));
      return;
    }

    setGraphData((previous) => applyGraphPatch(previous, patch));
    setChunkDict((previous) => applyChunkPatch(previous, patch));

    if (patch.removeNodeIds.length > 0 || patch.removeChunkIds.length > 0) {
      setDraftGraphData((previous) => applyGraphPatch(previous, patch));
      setDraftChunkDict((previous) => applyChunkPatch(previous, patch));
    }
  }, []);

  // Subscribe to app-level upload context so file upload events flow into this page
  const upload = useUpload();
  useEffect(() => {
    upload.subscribe({
      onDataReceived: handleDataReceived,
      onChunksReceived: handleChunksReceived,
      onGraphPatchReceived: handleGraphPatchReceived,
      setConversationId,
      setFileName,
      setMessage,
    });

    // On mount, consume any buffered data from an upload that started before we mounted
    const buffered = upload.consumeBuffered();
    if (buffered.graphData) handleDataReceived(buffered.graphData);
    if (buffered.chunkDict) handleChunksReceived(buffered.chunkDict);
    if (buffered.conversationId) setConversationId(buffered.conversationId);
    if (buffered.fileName) setFileName(buffered.fileName);
    if (buffered.message) setMessage(buffered.message);
    buffered.graphPatches?.forEach(handleGraphPatchReceived);

    return () => upload.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedNode) return;
    if (allNodes.some((node) => node.id === selectedNode)) return;
    setSelectedNode(null);
  }, [allNodes, selectedNode]);

  const handleBack = useCallback(() => {
    if (hasData) {
      setShowBackConfirm(true);
    } else {
      navigate("/");
    }
  }, [hasData, navigate]);

  const handleConfirmBack = useCallback(async () => {
    await Promise.all([
      audioRef.current?.stopRecording(),
      triggerSave(),
    ]);
    navigate("/");
  }, [navigate, triggerSave]);

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="absolute top-3 left-3 z-30 p-3 text-gray-300 hover:text-gray-500 transition"
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
              End this recording?
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Auto-save is active. If cloud storage is unavailable, local fallback is used.
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowBackConfirm(false)}
                className="px-4 py-3 text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBack}
                className="px-4 py-3 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 transition"
              >
                End & Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main graph area */}
      <div className="flex-1 relative min-h-0">
        {/* Graph always renders when data exists */}
        {hasData && (
          <>
            <MinimalGraph
              graphData={displayGraphData}
              selectedNode={selectedNode}
              setSelectedNode={setSelectedNode}
            />
            <MinimalLegend
              speakerColorMap={speakerColorMap}
              conversationId={conversationId}
            />
          </>
        )}

        {/* Upload transcript overlay — shown during upload, minimizable */}
        {upload.isProcessing && upload.liveTranscriptLines.length > 0 && (
          <div className={`absolute bottom-0 left-0 right-0 z-30 transition-all duration-300 ${
            transcriptMinimized ? "" : hasData ? "h-[40%]" : "top-0"
          }`}>
            <div className={`${transcriptMinimized ? "" : "h-full"} bg-white/95 backdrop-blur border-t border-gray-200 shadow-lg flex flex-col`}>
              {/* Minimized: closed captions bar */}
              {transcriptMinimized ? (
                <div className="px-4 py-2">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="w-16 h-1 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${Math.round((upload.progress || 0) * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500 truncate">
                        {upload.statusText || "Processing..."}
                        {upload.etaText ? ` · ${upload.etaText}` : ""}
                      </span>
                    </div>
                    <button
                      onClick={() => setTranscriptMinimized(false)}
                      className="p-1 text-gray-400 hover:text-gray-600 transition"
                      title="Expand transcript"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 11 12 6 7 11" /></svg>
                    </button>
                  </div>
                  {/* Last 3 lines — closed caption style */}
                  <div className="space-y-0.5 overflow-hidden">
                    {upload.liveTranscriptLines.slice(-3).map((entry, i, arr) => {
                      const line = typeof entry === "string" ? entry : entry.text;
                      const isNewest = i === arr.length - 1;
                      const opacity = isNewest ? "text-gray-700" : i === arr.length - 2 ? "text-gray-400" : "text-gray-300";
                      return (
                        <p key={i} className={`text-[11px] leading-tight truncate ${opacity}`}>
                          {line}
                        </p>
                      );
                    })}
                  </div>
                </div>
              ) : (
              <>
              {/* Expanded header */}
              <div className="shrink-0 px-4 py-2 border-b border-gray-200 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-xs font-medium text-gray-600 truncate">
                    {upload.statusText || "Processing..."}
                  </span>
                  {upload.etaText && (
                    <span className="text-[10px] text-gray-400 whitespace-nowrap">{upload.etaText}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400">{upload.liveTranscriptLines.length} chunks</span>
                  <div className="w-20 h-1 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((upload.progress || 0) * 100)}%` }}
                    />
                  </div>
                  <button
                    onClick={() => setTranscriptMinimized(true)}
                    className="p-1 text-gray-400 hover:text-gray-600 transition"
                    title="Minimize to captions"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="7 13 12 18 17 13" />
                    </svg>
                  </button>
                </div>
              </div>
              {/* Scrollable transcript body */}
              <div className="flex-1 overflow-y-auto px-4 py-2" ref={(el) => {
                if (el) el.scrollTop = el.scrollHeight;
              }}>
                <div className="max-w-2xl mx-auto">
                  {(() => {
                    const speakerColors = {
                      A: "text-blue-700",
                      B: "text-emerald-700",
                      C: "text-amber-700",
                      D: "text-purple-700",
                      E: "text-rose-700",
                    };
                    const formatElapsed = (ms) => {
                      if (!ms || !Number.isFinite(ms)) return null;
                      const s = Math.floor(ms / 1000);
                      const m = Math.floor(s / 60);
                      const h = Math.floor(m / 60);
                      if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`;
                      if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`;
                      return `${s}s`;
                    };
                    const segments = [];
                    const labelRegex = /(?:^|(?<=\s))([A-Z]):\s/g;
                    upload.liveTranscriptLines.forEach((entry) => {
                      const line = typeof entry === "string" ? entry : entry.text;
                      const chunkMeta = typeof entry === "object" ? entry : null;
                      const matches = [...line.matchAll(labelRegex)];
                      if (matches.length === 0) {
                        if (line.trim()) segments.push({ speaker: null, text: line.trim(), meta: chunkMeta });
                        return;
                      }
                      const preamble = line.slice(0, matches[0].index).trim();
                      if (preamble) segments.push({ speaker: null, text: preamble, meta: chunkMeta });
                      matches.forEach((m, mi) => {
                        const speaker = m[1];
                        const textStart = m.index + m[0].length;
                        const textEnd = mi < matches.length - 1 ? matches[mi + 1].index : line.length;
                        const text = line.slice(textStart, textEnd).trim();
                        if (text) segments.push({ speaker, text, meta: mi === 0 ? chunkMeta : null });
                      });
                    });
                    let prevSpeaker = null;
                    return segments.map((seg, i) => {
                      const isSpeakerChange = i > 0 && seg.speaker !== prevSpeaker;
                      const color = seg.speaker ? (speakerColors[seg.speaker] || "text-gray-700") : "text-gray-500";
                      const spacing = isSpeakerChange ? "mt-4" : i > 0 ? "mt-2" : "";
                      prevSpeaker = seg.speaker;
                      const elapsed = seg.meta ? formatElapsed(seg.meta.elapsedMs) : null;
                      const chunkLabel = seg.meta?.chunkIndex && seg.meta?.total
                        ? `${seg.meta.chunkIndex}/${seg.meta.total}`
                        : null;
                      return (
                        <div key={i} className={spacing}>
                          {(chunkLabel || elapsed) && (
                            <div className="text-[9px] text-gray-400 font-mono select-none mb-0.5">
                              {[chunkLabel, elapsed].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          <p className={`text-xs leading-relaxed ${color}`}>
                            {seg.speaker && <span className="font-semibold">{seg.speaker}: </span>}
                            {seg.text}
                          </p>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
              </>
              )}
            </div>
          </div>
        )}

        {/* Node detail panel */}
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={displayChunkDict}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>

      {/* Timeline ribbon */}
      {hasData && (
        <TimelineRibbon
          graphData={displayGraphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
        />
      )}

      {/* Auto-save status indicator */}
      {hasFinalizedData && (
        <div className="absolute bottom-16 right-3 z-20 text-[10px] text-gray-400 select-none">
          {saveStatus === "saving" && "Saving…"}
          {saveStatus === "saved" && lastSavedAt && (
            <>Saved {lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>
          )}
          {saveStatus === "error" && (
            <span className="text-red-400">Save failed</span>
          )}
        </div>
      )}

      {/* Audio footer */}
      <div className="shrink-0 w-full py-2 px-4 flex items-center justify-center border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
        <div className="w-full max-w-5xl flex items-center justify-center gap-4">
          <FileUpload />
          <AudioInput
            ref={audioRef}
            onDataReceived={handleDataReceived}
            onChunksReceived={handleChunksReceived}
            onGraphPatchReceived={handleGraphPatchReceived}
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
    </div>
  );
}
