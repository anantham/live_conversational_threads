import { buildGraphAggregationViews } from "./graphAggregationExport";

const EXPORT_SCHEMA_VERSION = 1;

function safeClone(value) {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function flattenGraph(graphData) {
  return Array.isArray(graphData) ? graphData.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [])) : [];
}

function countEdges(nodes) {
  return nodes.reduce((total, node) => {
    const outgoing = Array.isArray(node?.connected_node_ids) ? node.connected_node_ids.length : 0;
    const incoming = Array.isArray(node?.incoming_node_ids) ? node.incoming_node_ids.length : 0;
    return total + outgoing + incoming;
  }, 0);
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => ({
    id: line?.id ?? null,
    text: String(line?.text || ""),
    is_final: Boolean(line?.isFinal),
    confidence: Number.isFinite(line?.confidence) ? line.confidence : null,
  }));
}

function buildStats({ graphData, draftGraphData, chunkDict, draftChunkDict, audioSession }) {
  const finalizedNodes = flattenGraph(graphData);
  const draftNodes = flattenGraph(draftGraphData);
  const finalizedChunkCount = Object.keys(chunkDict || {}).length;
  const draftChunkCount = Object.keys(draftChunkDict || {}).length;

  return {
    finalized_node_count: finalizedNodes.length,
    draft_node_count: draftNodes.length,
    finalized_edge_count: countEdges(finalizedNodes),
    draft_edge_count: countEdges(draftNodes),
    finalized_chunk_count: finalizedChunkCount,
    draft_chunk_count: draftChunkCount,
    live_transcript_line_count: Array.isArray(audioSession?.live_transcript_lines)
      ? audioSession.live_transcript_lines.length
      : 0,
    event_count: Array.isArray(audioSession?.event_timeline) ? audioSession.event_timeline.length : 0,
  };
}

export function buildConversationDebugExport({
  conversationId,
  fileName,
  message,
  graphData,
  draftGraphData,
  chunkDict,
  draftChunkDict,
  audioRecovery,
  audioSession,
  backendObservability,
}) {
  const exportGraphLayers = Array.isArray(graphData) && graphData.length > 0
    ? graphData
    : (draftGraphData || []);
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    conversation: {
      id: conversationId || null,
      file_name: String(fileName || ""),
      message: String(message || ""),
    },
    stats: buildStats({
      graphData,
      draftGraphData,
      chunkDict,
      draftChunkDict,
      audioSession,
    }),
    graph: {
      finalized_layers: safeClone(graphData || []),
      draft_layers: safeClone(draftGraphData || []),
    },
    aggregation_views: buildGraphAggregationViews(exportGraphLayers, chunkDict),
    transcript: {
      finalized_chunks: safeClone(chunkDict || {}),
      draft_chunks: safeClone(draftChunkDict || {}),
      live_lines: normalizeLines(audioSession?.live_transcript_lines),
    },
    audio: {
      recovery: safeClone(audioRecovery),
      session: {
        download_url: String(audioSession?.audio_download_url || ""),
        active_settings: safeClone(audioSession?.active_settings),
      },
    },
    runtime: {
      recording: Boolean(audioSession?.recording),
      backend_socket_state: String(audioSession?.backend_socket_state || "idle"),
      provider_socket_state: String(audioSession?.provider_socket_state || "idle"),
      session_started_at: audioSession?.session_started_at || null,
      session_ended_at: audioSession?.session_ended_at || null,
      processing_error: String(audioSession?.processing_error || ""),
      session_ack: safeClone(audioSession?.session_ack),
      status_line: safeClone(audioSession?.status_line),
      chips: safeClone(audioSession?.chips),
      details: safeClone(audioSession?.details),
      event_timeline: safeClone(audioSession?.event_timeline || []),
    },
    backend_observability: safeClone(backendObservability || {}),
  };
}

export function downloadConversationDebugExport(payload, conversationId, fileName) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const baseName = String(fileName || conversationId || "conversation-debug")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "conversation-debug";

  anchor.href = objectUrl;
  anchor.download = `${baseName}-session-debug.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
