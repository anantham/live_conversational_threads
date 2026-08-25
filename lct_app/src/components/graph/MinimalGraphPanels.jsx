import PropTypes from "prop-types";

export default function MinimalGraphPanels({
  hoveredEdge,
  clickedEdge,
  setClickedEdge,
  selectedCluster,
  selectedClusterMembers,
  setSelectedCluster,
  setLockedLevel,
  setSelectedNode,
}) {
  return (
    <>
      {hoveredEdge && !clickedEdge && (
        <div className="absolute top-4 right-4 z-30 max-w-xs rounded-md bg-white/95 px-3 py-2 text-xs text-gray-700 shadow-sm border border-gray-200 pointer-events-none">
          <span className="font-medium capitalize">{hoveredEdge.relationType}</span>
          {hoveredEdge.relationText && (
            <p className="mt-0.5 text-gray-500 line-clamp-2">{hoveredEdge.relationText}</p>
          )}
          <p className="mt-1 text-[10px] text-gray-500">click to pin</p>
        </div>
      )}

      {clickedEdge && (
        <div className="absolute bottom-2 left-2 right-2 z-30 rounded-lg border border-gray-200 bg-white px-4 py-3 text-xs text-gray-700 shadow-lg sm:bottom-14 sm:left-auto sm:right-4 sm:w-72">
          <div className="flex items-start justify-between gap-2 mb-2">
            <span className="font-semibold text-gray-900 capitalize leading-tight">
              {clickedEdge.relationType?.replace(/_/g, " ")}
            </span>
            <button
              onClick={() => setClickedEdge(null)}
              className="mt-0.5 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-sm leading-none text-gray-500 hover:text-gray-700 sm:min-h-0 sm:min-w-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {(clickedEdge.sourceLabel || clickedEdge.targetLabel) && (
            <p className="text-[10px] text-gray-500 mb-2 truncate">
              {clickedEdge.sourceLabel}
              <span className="mx-1">→</span>
              {clickedEdge.targetLabel}
            </p>
          )}
          {clickedEdge.relationText ? (
            <p className="leading-relaxed text-gray-600">{clickedEdge.relationText}</p>
          ) : (
            <p className="text-gray-500 italic">No relation detail available.</p>
          )}
        </div>
      )}

      {selectedCluster && selectedClusterMembers.length > 0 && (
        <div className="absolute inset-x-2 bottom-2 z-30 flex max-h-[72vh] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white text-xs text-gray-700 shadow-lg sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-14 sm:max-h-[60vh] sm:w-80">
          <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-gray-100 shrink-0">
            <div>
              <span className="font-semibold text-gray-900 text-sm leading-tight block">
                {selectedCluster.label}
              </span>
              <span className="text-[10px] text-gray-500 mt-0.5 block">
                {selectedClusterMembers.length} nodes in this cluster
              </span>
            </div>
            <button
              onClick={() => setSelectedCluster(null)}
              className="mt-0.5 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-sm leading-none text-gray-500 hover:text-gray-700 sm:min-h-0 sm:min-w-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-2 flex-1">
            {selectedClusterMembers.map((node, i) => (
              <div
                key={node.id}
                className="-mx-1 min-h-11 cursor-pointer rounded border-b border-gray-50 px-1 py-2 last:border-0 hover:bg-gray-50"
                onClick={() => {
                  setLockedLevel(0);
                  setSelectedNode(node.id);
                  setSelectedCluster(null);
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-300 font-mono w-4 shrink-0">{i + 1}</span>
                  <span className="font-medium text-gray-800 truncate">{node.node_name}</span>
                </div>
                {node.source_excerpt && (
                  <p className="text-[10px] text-gray-500 mt-0.5 ml-6 line-clamp-2">{node.source_excerpt}</p>
                )}
                {node.summary && !node.source_excerpt && (
                  <p className="text-[10px] text-gray-500 mt-0.5 ml-6 line-clamp-2">{node.summary}</p>
                )}
                <div className="flex gap-2 mt-1 ml-6">
                  {(node.speaker_display || node.speaker_id) && (
                    <span className="text-[9px] text-gray-500">speaker: {node.speaker_display || node.speaker_id}</span>
                  )}
                  {(() => {
                    const explicitCount = Array.isArray(node.explicit_edges_in)
                      ? node.explicit_edges_in.length + node.explicit_edges_out.length
                      : null;
                    const edgeCount = explicitCount ?? node.edge_relations?.length ?? 0;
                    return edgeCount > 0
                      ? <span className="text-[9px] text-gray-500">{edgeCount} edges</span>
                      : null;
                  })()}
                  {node.thread_state && node.thread_state !== "continue_thread" && (
                    <span className="text-[9px] text-blue-400">{node.thread_state.replace(/_/g, " ")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </>
  );
}

MinimalGraphPanels.propTypes = {
  hoveredEdge: PropTypes.object,
  clickedEdge: PropTypes.object,
  setClickedEdge: PropTypes.func.isRequired,
  selectedCluster: PropTypes.object,
  selectedClusterMembers: PropTypes.array.isRequired,
  setSelectedCluster: PropTypes.func.isRequired,
  setLockedLevel: PropTypes.func.isRequired,
  setSelectedNode: PropTypes.func.isRequired,
};
