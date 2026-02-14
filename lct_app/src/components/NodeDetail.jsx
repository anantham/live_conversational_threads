import PropTypes from "prop-types";

export default function NodeDetail({ node, onClose }) {
  if (!node) return null;

  const relations = Array.isArray(node.edge_relations) ? node.edge_relations : [];
  const contextualRelations = node.contextual_relation
    ? Object.entries(node.contextual_relation)
    : [];

  return (
    <div className="fixed top-0 right-0 h-full w-full sm:w-80 sm:max-w-[85vw] bg-white shadow-lg border-l border-gray-200 z-40 flex flex-col animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 truncate pr-2">
          {node.node_name}
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
        {node.speaker_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Speaker</span>
            <p className="text-gray-700 mt-0.5">{node.speaker_id}</p>
          </div>
        )}

        {/* Summary */}
        {node.summary && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Summary</span>
            <p className="text-gray-700 mt-0.5 leading-relaxed">{node.summary}</p>
          </div>
        )}

        {/* Full text / transcript excerpt */}
        {node.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transcript</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {node.full_text}
            </p>
          </div>
        )}

        {/* Source excerpt */}
        {node.source_excerpt && !node.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Source</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {node.source_excerpt}
            </p>
          </div>
        )}

        {/* Thread */}
        {node.thread_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Thread</span>
            <p className="text-gray-700 mt-0.5">
              {node.thread_id}
              {node.thread_state && (
                <span className="ml-2 text-xs text-gray-400">({node.thread_state})</span>
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
        {node.claims && node.claims.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Claims</span>
            <ul className="mt-1 space-y-0.5">
              {node.claims.map((claim, i) => (
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
  onClose: PropTypes.func.isRequired,
};
