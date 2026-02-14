import { useEffect, useMemo } from "react";
import PropTypes from "prop-types";

export default function NodeDetail({ node, chunkDict, onClose }) {
  const safeNode = node ?? null;
  const relations = Array.isArray(safeNode?.edge_relations) ? safeNode.edge_relations : [];
  const contextualRelations = safeNode?.contextual_relation
    ? Object.entries(safeNode.contextual_relation)
    : [];

  const rawTranscript = safeNode?.chunk_id ? chunkDict?.[safeNode.chunk_id] || null : null;

  const highlightedTranscript = useMemo(() => {
    if (!rawTranscript || !safeNode?.full_text) return null;
    const lines = rawTranscript.split("\n");
    const needle = safeNode.full_text.trim().substring(0, 40);
    if (!needle) return null;

    const startIdx = lines.findIndex((line) => line.includes(needle));
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
    <div className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[85vw] flex-col border-l border-gray-200 bg-white shadow-lg sm:w-80">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h3 className="truncate pr-2 text-sm font-semibold text-gray-800">{safeNode.node_name}</h3>
        <button
          onClick={onClose}
          className="shrink-0 p-3 text-gray-400 transition hover:text-gray-600"
          aria-label="Close node detail"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
        {safeNode.speaker_id && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Speaker</span>
            <p className="mt-0.5 text-gray-700">{safeNode.speaker_id}</p>
          </div>
        )}

        {safeNode.summary && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Summary</span>
            <p className="mt-0.5 leading-relaxed text-gray-700">{safeNode.summary}</p>
          </div>
        )}

        {safeNode.full_text && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Transcript</span>
            <p className="mt-0.5 rounded bg-gray-50 p-2 text-xs leading-relaxed text-gray-600">
              {safeNode.full_text}
            </p>
          </div>
        )}

        {safeNode.source_excerpt && !safeNode.full_text && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Source</span>
            <p className="mt-0.5 rounded bg-gray-50 p-2 text-xs leading-relaxed text-gray-600">
              {safeNode.source_excerpt}
            </p>
          </div>
        )}

        {rawTranscript && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
              Raw Transcript
            </span>
            <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs leading-relaxed text-gray-600">
              {highlightedTranscript
                ? highlightedTranscript.lines.map((line, index) => {
                    const isHighlighted =
                      highlightedTranscript.startIdx !== -1 &&
                      index >= highlightedTranscript.startIdx &&
                      index < highlightedTranscript.startIdx + highlightedTranscript.nodeLineCount;
                    return (
                      <div key={index} className={isHighlighted ? "rounded bg-amber-100 px-0.5" : ""}>
                        {line || "\u00A0"}
                      </div>
                    );
                  })
                : rawTranscript}
            </div>
          </div>
        )}

        {safeNode.thread_id && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Thread</span>
            <p className="mt-0.5 text-gray-700">
              {safeNode.thread_id}
              {safeNode.thread_state && (
                <span className="ml-2 text-xs text-gray-400">({safeNode.thread_state})</span>
              )}
            </p>
          </div>
        )}

        {relations.length > 0 && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Relations</span>
            <ul className="mt-1 space-y-1">
              {relations.map((relation, index) => (
                <li key={index} className="flex items-start gap-1.5 text-xs text-gray-600">
                  <span className="shrink-0 font-medium text-gray-500">{relation.relation_type}</span>
                  <span className="text-gray-400">
                    {relation.related_node}: {relation.relation_text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {relations.length === 0 && contextualRelations.length > 0 && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Context</span>
            <ul className="mt-1 space-y-1">
              {contextualRelations.map(([name, text]) => (
                <li key={name} className="text-xs text-gray-600">
                  <span className="font-medium text-gray-500">{name}:</span> {text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {safeNode.claims && safeNode.claims.length > 0 && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Claims</span>
            <ul className="mt-1 space-y-0.5">
              {safeNode.claims.map((claim, index) => (
                <li key={index} className="text-xs text-gray-600">
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
