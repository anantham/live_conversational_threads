import { useEffect, useMemo } from "react";
import PropTypes from "prop-types";

export default function NodeDetail({ node, chunkDict, onClose }) {
  const safeNode = node ?? null;

  const relations = Array.isArray(safeNode?.edge_relations) ? safeNode.edge_relations : [];
  const contextualRelations = safeNode?.contextual_relation
    ? Object.entries(safeNode.contextual_relation)
    : [];

  // Raw transcript for this node's chunk
  const rawTranscript = safeNode?.chunk_id ? chunkDict?.[safeNode.chunk_id] || null : null;

  // Split raw transcript into lines and find the node's text within it
  const highlightedTranscript = useMemo(() => {
    if (!rawTranscript || !safeNode?.full_text) return null;
    const lines = rawTranscript.split("\n");
    const needle = safeNode.full_text.trim().substring(0, 40);
    if (!needle) return null;
    const startIdx = lines.findIndex((l) => l.includes(needle));
    const nodeLineCount = safeNode.full_text.split("\n").length;
    return { lines, startIdx, nodeLineCount };
  }, [rawTranscript, safeNode?.full_text]);

  useEffect(() => {
    if (!safeNode) return undefined;
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [safeNode, onClose]);

  if (!safeNode) return null;

  return (
    <div className="fixed top-0 right-0 h-full w-full sm:w-80 sm:max-w-[85vw] bg-white shadow-lg border-l border-gray-200 z-40 flex flex-col animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 truncate pr-2">
          {safeNode.node_name}
        </h3>
        <button
          onClick={onClose}
          className="p-3 text-gray-400 hover:text-gray-600 transition shrink-0"
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
        {safeNode.speaker_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Speaker</span>
            <p className="text-gray-700 mt-0.5">{safeNode.speaker_id}</p>
          </div>
        )}

        {/* Summary */}
        {safeNode.summary && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Summary</span>
            <p className="text-gray-700 mt-0.5 leading-relaxed">{safeNode.summary}</p>
          </div>
        )}

        {/* Full text / transcript excerpt */}
        {safeNode.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transcript</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {safeNode.full_text}
            </p>
          </div>
        )}

        {/* Source excerpt */}
        {safeNode.source_excerpt && !safeNode.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Source</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {safeNode.source_excerpt}
            </p>
          </div>
        )}

        {/* Raw transcript chunk (what the LLM saw) */}
        {rawTranscript && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Raw Transcript
            </span>
            <div className="mt-1 max-h-48 overflow-y-auto rounded bg-gray-50 border border-gray-100 px-2 py-1.5 text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">
              {highlightedTranscript
                ? highlightedTranscript.lines.map((line, i) => {
                    const isHL =
                      highlightedTranscript.startIdx !== -1 &&
                      i >= highlightedTranscript.startIdx &&
                      i < highlightedTranscript.startIdx + highlightedTranscript.nodeLineCount;
                    return (
                      <div
                        key={i}
                        className={isHL ? "bg-amber-100 rounded px-0.5" : ""}
                      >
                        {line || "\u00A0"}
                      </div>
                    );
                  })
                : rawTranscript}
            </div>
          </div>
        )}

        {/* Thread */}
        {safeNode.thread_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Thread</span>
            <p className="text-gray-700 mt-0.5">
              {safeNode.thread_id}
              {safeNode.thread_state && (
                <span className="ml-2 text-xs text-gray-400">({safeNode.thread_state})</span>
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
        {safeNode.claims && safeNode.claims.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Claims</span>
            <ul className="mt-1 space-y-0.5">
              {safeNode.claims.map((claim, i) => (
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
  chunkDict: PropTypes.object,
  onClose: PropTypes.func.isRequired,
};
