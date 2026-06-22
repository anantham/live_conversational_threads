import PropTypes from "prop-types";

import { AUTHORED_LEVELS, EDGE_COLORS } from "../graphConstants";

export default function MinimalGraphPanels({
  hoveredEdge,
  clickedEdge,
  setClickedEdge,
  selectedCluster,
  selectedClusterMembers,
  setSelectedCluster,
  setLockedLevel,
  setSelectedNode,
  normalizedChunk,
  displayMode,
  effectiveSemanticLevel,
  effectiveClusterLevel,
  speakerColorMap,
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
        <div className="absolute bottom-14 right-4 z-30 w-72 rounded-lg bg-white border border-gray-200 shadow-lg px-4 py-3 text-xs text-gray-700">
          <div className="flex items-start justify-between gap-2 mb-2">
            <span className="font-semibold text-gray-900 capitalize leading-tight">
              {clickedEdge.relationType?.replace(/_/g, " ")}
            </span>
            <button
              onClick={() => setClickedEdge(null)}
              className="text-gray-500 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
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
        <div className="absolute top-14 right-4 z-30 w-80 max-h-[60vh] rounded-lg bg-white border border-gray-200 shadow-lg text-xs text-gray-700 overflow-hidden flex flex-col">
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
              className="text-gray-500 hover:text-gray-700 shrink-0 leading-none text-sm mt-0.5"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-2 flex-1">
            {selectedClusterMembers.map((node, i) => (
              <div
                key={node.id}
                className="py-2 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 -mx-1 px-1 rounded"
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
                  {node.edge_relations?.length > 0 && (
                    <span className="text-[9px] text-gray-500">{node.edge_relations.length} edges</span>
                  )}
                  {node.thread_state && node.thread_state !== "continue_thread" && (
                    <span className="text-[9px] text-blue-400">{node.thread_state.replace(/_/g, " ")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {normalizedChunk.length > 0 && (
        <div className="absolute bottom-4 left-40 z-40">
          <details className="group">
            <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2.5 py-1.5 bg-white/85 hover:bg-white/95 rounded-full shadow-sm border border-gray-200 text-gray-500 hover:text-gray-700 transition opacity-80 hover:opacity-100 text-[10px] font-medium">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Colors
            </summary>
            <div className="absolute bottom-full left-0 mb-2 bg-white/95 rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-2 min-w-[180px] animate-slideIn">
              {displayMode === "semantic" ? (
                <>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Current semantic level</span>
                    <div className="mt-1 text-[11px] text-gray-600">
                      {AUTHORED_LEVELS.find((spec) => spec.level === effectiveSemanticLevel)?.label || "authored"}
                    </div>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      This view is using backend-authored hierarchy, not frontend clustering.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Speaker / temporal palette</span>
                    <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                      Speaker colors appear when multiple speakers are detected. Otherwise colors fade by temporal position.
                    </div>
                  </div>
                </>
              ) : effectiveClusterLevel === 0 ? (
                <>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Speaker</span>
                    <div className="mt-1 space-y-1">
                      {Object.entries(speakerColorMap).slice(0, 5).map(([sid, color]) => (
                        <div key={sid} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full border border-gray-300" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{sid}</span>
                        </div>
                      ))}
                      {Object.keys(speakerColorMap).length === 0 && (
                        <span className="text-gray-500 italic">No speakers detected</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Edge color = Relation</span>
                    <div className="mt-1 space-y-1">
                      {[
                        { label: "supports", color: EDGE_COLORS.supports },
                        { label: "rebuts", color: EDGE_COLORS.rebuts },
                        { label: "clarifies", color: EDGE_COLORS.clarifies },
                        { label: "tangent", color: EDGE_COLORS.tangent },
                        { label: "temporal", color: EDGE_COLORS.temporal_next },
                      ].map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Node color = Wavelength Rainbow</span>
                    <div className="mt-2 flex flex-col gap-1">
                      <div
                        className="h-2 w-full rounded-full"
                        style={{ background: "linear-gradient(to right, hsl(0, 75%, 88%), hsl(140, 75%, 88%), hsl(280, 75%, 88%))" }}
                      />
                      <div className="flex justify-between text-[9px] text-gray-500 font-mono uppercase tracking-tight">
                        <span>Start</span>
                        <span>Now</span>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-gray-500 leading-tight">
                      Nodes stretch across the spectrum as the conversation grows. Labels update to speaker colors after ~2 mins.
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-500 uppercase tracking-wider text-[10px]">Edge color = Agreement</span>
                    <div className="mt-1 space-y-1">
                      {[
                        { label: "supports / agrees", color: EDGE_COLORS.supports },
                        { label: "rebuts / disagrees", color: EDGE_COLORS.rebuts },
                        { label: "clarifies", color: EDGE_COLORS.clarifies },
                        { label: "temporal flow", color: EDGE_COLORS.temporal_next },
                      ].map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                          <span className="text-gray-600">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-500">
                    Edge thickness = number of connections between clusters
                  </div>
                </>
              )}
            </div>
          </details>
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
  normalizedChunk: PropTypes.array.isRequired,
  displayMode: PropTypes.string.isRequired,
  effectiveSemanticLevel: PropTypes.number,
  effectiveClusterLevel: PropTypes.number,
  speakerColorMap: PropTypes.object.isRequired,
};