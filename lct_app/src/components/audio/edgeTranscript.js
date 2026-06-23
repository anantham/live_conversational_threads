/**
 * Edge STT → backend ingestion glue (ADR-056 Phase 1b).
 *
 * Maps a `useEdgeStt` result into the WebSocket message the backend's EXISTING
 * client-transcript ingestion already accepts on `/ws/transcripts`
 * (`handle_transcript_event` → `transcript_partial` / `transcript_final`, which
 * carries `text` + `segments` into `_persist_event` → persist/graph/speaker
 * materialization). So edge STT reuses the existing pipeline with no backend
 * change — the diarized `segments` (with per-segment ECAPA `embedding`) flow
 * through the same materialization the relay path uses.
 *
 * Pure function — unit-tested in `edgeTranscript.test.js`.
 *
 * @param {object} result a `useEdgeStt` onTranscript payload
 * @returns {object} a `/ws/transcripts` message
 */
export function edgeResultToWsMessage(result = {}) {
  const message = {
    type: result.isFinal ? "transcript_final" : "transcript_partial",
    text: (result.text || "").trim(),
    timestamps: result.timestamps && typeof result.timestamps === "object" ? result.timestamps : {},
    metadata: {
      source: "web_client",
      transport: "edge_m5", // tags the path so server logs distinguish edge vs relay
      utterance_id: result.utteranceId,
      engine: result.engine || "edge",
    },
  };
  // segments carry speaker + per-segment embedding; only attach a non-empty list
  // (handle_transcript_event ignores a missing/empty `segments`).
  if (Array.isArray(result.segments) && result.segments.length > 0) {
    message.segments = result.segments;
  }
  // top-level per-speaker means aren't read by handle_transcript_event today;
  // stash them in metadata so a later increment can persist them if wanted.
  if (result.speakerEmbeddings && typeof result.speakerEmbeddings === "object") {
    message.metadata.speaker_embeddings = result.speakerEmbeddings;
  }
  return message;
}
