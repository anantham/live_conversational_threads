import PropTypes from "prop-types";
import { LockKeyhole } from "lucide-react";

import { AUTHORED_LEVELS } from "../graphConstants";
import { mglog } from "./minimalGraphDebug";

const LEGACY_TIER_SPECS = [
  { label: "nodes", level: 0, chip: "bg-gray-100", border: "border-gray-400", color: "text-gray-700" },
  { label: "sentences", level: 1, chip: "bg-teal-50", border: "border-teal-400", color: "text-teal-700" },
  { label: "topics", level: 2, chip: "bg-blue-50", border: "border-blue-400", color: "text-blue-700" },
  { label: "themes", level: 3, chip: "bg-purple-50", border: "border-purple-400", color: "text-purple-700" },
];

export default function MinimalGraphHud({
  zoomLevel,
  clusterLevelLabel,
  displayMode,
  effectiveSemanticLevel,
  effectiveClusterLevel,
  displayNodes,
  displayEdges,
  projectionStats,
  normalizedChunk,
  lockedLevel,
  drilldownPath,
  setDrilldownPath,
  legacyClusterLevel,
  autoFollowRef,
  setAutoFollow,
  userOverrodeTierRef,
  setLockedLevel,
  neighborhoodFocus,
  clearNeighborhoodFocus,
}) {
  const tierSpecs = displayMode === "semantic" ? AUTHORED_LEVELS : LEGACY_TIER_SPECS;
  const visibleSemanticLevel = Number(
    displayNodes[0]?.data?.fullData?.semantic_level
      ?? displayNodes[0]?.data?.fullData?.level
      ?? displayNodes[0]?.data?.semantic_level
      ?? effectiveSemanticLevel,
  );
  const semanticTierSpec = AUTHORED_LEVELS.find(
    (spec) => spec.level === visibleSemanticLevel,
  );
  const semanticTierWord = displayNodes.length === 1
    ? (semanticTierSpec?.singular || "node")
    : (semanticTierSpec?.label || "nodes");
  const activeTierCount = `${displayNodes.length} ${semanticTierWord}`;
  const macroRelationSummary = displayMode === "semantic" && visibleSemanticLevel >= 3 && projectionStats
    ? projectionStats.projectionLimited
      ? "topology too dense to project safely"
      : projectionStats.projectedPairCount > 0
      ? `${projectionStats.projectedPairCount} cross-${semanticTierSpec?.singular || "node"} links`
      : `no cross-${semanticTierSpec?.singular || "node"} links authored`
    : null;
  const unmappedRelationSummary = projectionStats?.unmappedEdgeCount > 0
    ? `${projectionStats.unmappedEdgeCount} unmapped`
    : null;

  // left-16 (not left-3) reserves room for the page-level Back button (a ~54px
  // padded icon at top-3 left-3, z-50) so it no longer covers the zoom % chip /
  // tier controls (#6).
  return (
    <div className="absolute left-2 right-2 top-2 z-40 flex select-none flex-col items-stretch gap-1 whitespace-nowrap sm:left-16 sm:right-3 sm:top-3 sm:flex-row sm:items-center sm:gap-2 sm:overflow-x-auto">
      <div className="flex min-h-11 flex-shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-white/95 px-2.5 py-1.5 shadow-sm sm:min-h-0">
        <span className="text-[10px] font-mono text-gray-500">{Math.round(zoomLevel * 100)}%</span>
        <span className="text-[9px] text-gray-300">|</span>
        {clusterLevelLabel ? (
          <>
            <span className={`text-[10px] font-semibold ${
              displayMode === "semantic"
                ? (semanticTierSpec?.color || "text-blue-600")
                : effectiveClusterLevel === 3
                ? "text-purple-600"
                : effectiveClusterLevel === 2
                ? "text-blue-600"
                : "text-teal-600"
            }`}>
              {clusterLevelLabel}
            </span>
            <span className="text-[10px] text-gray-500">
              {displayMode === "semantic"
                ? activeTierCount
                : `${displayNodes.length} clusters · ${normalizedChunk.length} nodes`}
            </span>
            {macroRelationSummary ? (
              <span
                className={`text-[10px] ${projectionStats.projectionLimited ? "font-semibold text-amber-700" : "text-slate-600"}`}
                title={projectionStats.projectionLimited
                  ? `Macro topology was not rendered: ${projectionStats.limitationReason}.`
                  : `${projectionStats.semanticEdgeCount} semantic edges considered; ${projectionStats.internalEdgeCount} remain internal at this level; ${projectionStats.unmappedEdgeCount} could not be mapped.`}
              >
                · {macroRelationSummary}
              </span>
            ) : null}
            {unmappedRelationSummary && !projectionStats?.projectionLimited ? (
              <span className="text-[10px] font-semibold text-amber-700">
                · {unmappedRelationSummary}
              </span>
            ) : null}
            {lockedLevel != null && (
              <span className="text-[9px] text-amber-500 ml-1">locked</span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-gray-500">
            {normalizedChunk.length} nodes · {displayEdges.length} edges
            {lockedLevel != null && (
              <span className="text-[9px] text-amber-500 ml-1">locked</span>
            )}
          </span>
        )}
      </div>

      {drilldownPath.length > 0 && (
        <div className="flex-shrink-0 flex items-center gap-1.5 text-[11px] text-gray-600 bg-white/95 border border-gray-200 shadow-sm rounded-md px-2 py-1">
          <button
            type="button"
            className="flex items-center gap-1 rounded bg-gray-100 border border-gray-300 px-2 py-0.5 font-semibold text-gray-700 hover:bg-gray-200 hover:text-gray-900 cursor-pointer"
            onClick={() => {
              autoFollowRef.current = false;
              clearNeighborhoodFocus?.(false);
              setDrilldownPath((prev) => prev.slice(0, -1));
            }}
            title="Back up one level (Esc)"
          >
            <span aria-hidden="true">←</span> Back
          </button>
          <button
            type="button"
            className="text-blue-600 hover:underline font-medium cursor-pointer"
            onClick={() => {
              autoFollowRef.current = false;
              clearNeighborhoodFocus?.(false);
              setDrilldownPath([]);
            }}
            title="Jump back to the top tier"
          >
            {AUTHORED_LEVELS.find((spec) => spec.level === (lockedLevel ?? drilldownPath[0]?.level))?.label || "top"}
          </button>
          {drilldownPath.map((crumb, idx) => (
            <span key={`${crumb.nodeId}-${idx}`} className="flex items-center gap-1">
              <span className="text-gray-500">/</span>
              <button
                type="button"
                className={
                  idx === drilldownPath.length - 1
                    ? "text-gray-900 font-medium cursor-default"
                    : "text-blue-600 hover:underline cursor-pointer"
                }
                onClick={() => {
                  if (idx === drilldownPath.length - 1) return;
                  autoFollowRef.current = false;
                  clearNeighborhoodFocus?.(false);
                  setDrilldownPath((prev) => prev.slice(0, idx + 1));
                }}
                title={crumb.nodeName}
              >
                {crumb.nodeName.length > 28 ? `${crumb.nodeName.slice(0, 28)}…` : crumb.nodeName}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex w-full flex-shrink-0 items-center gap-0 overflow-x-auto rounded-md border border-gray-200 bg-white/95 shadow-sm sm:w-auto sm:overflow-hidden">
        {tierSpecs.map(({ label, level, chip, border, color }) => {
          const isActive = displayMode === "semantic"
            ? effectiveSemanticLevel === level
            : legacyClusterLevel === level;
          const isLocked = lockedLevel === level;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={isLocked}
              onClick={() => {
                autoFollowRef.current = false;
                setAutoFollow(false);
                clearNeighborhoodFocus?.(false);
                userOverrodeTierRef.current = true;
                mglog("tier button click", { clickedLevel: level, label, prevLockedLevel: lockedLevel, displayMode, willUnlock: lockedLevel === level, drillDepth: drilldownPath.length });
                const tailLevel = drilldownPath.length
                  ? drilldownPath[drilldownPath.length - 1].level
                  : null;
                if (!(tailLevel != null && level < tailLevel)) {
                  setDrilldownPath([]);
                }
                if (lockedLevel === level) {
                  setLockedLevel(null);
                } else {
                  setLockedLevel(level);
                }
              }}
              title={isLocked ? `Locked to ${label} — click to unlock` : `Click to lock at ${label} level`}
              className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1 px-3 py-1 text-[10px] font-medium transition-colors cursor-pointer sm:min-h-0 sm:flex-none sm:px-2 sm:text-[9px] ${
                isActive
                  ? `${chip} ${color} border-b-2 ${border}`
                  : isLocked
                  ? `${chip} ${color} border-b-2 border-dashed ${border}`
                  : "text-gray-500 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              {label}{isLocked ? <LockKeyhole aria-hidden="true" className="h-3 w-3" /> : null}
            </button>
          );
        })}
      </div>

      {neighborhoodFocus ? (
        <div
          data-testid="neighborhood-focus-status"
          className="flex min-h-11 min-w-0 flex-shrink items-center gap-2 rounded-md border border-amber-300 bg-amber-50/95 px-2.5 py-1.5 text-[10px] text-amber-950 shadow-sm sm:min-h-0"
        >
          <span className="min-w-0 truncate font-semibold" title={neighborhoodFocus.title}>
            Related to: {neighborhoodFocus.title}
          </span>
          <span className="shrink-0 text-amber-700">
            {neighborhoodFocus.directNeighborCount > 0
              ? `${neighborhoodFocus.directNeighborCount} direct ${neighborhoodFocus.directNeighborCount === 1 ? "link" : "links"}`
              : "No direct semantic links at this level"}
          </span>
          <button
            type="button"
            onClick={() => clearNeighborhoodFocus?.()}
            className="ml-auto min-h-9 shrink-0 rounded border border-amber-300 bg-white px-2 font-semibold text-amber-800 hover:bg-amber-100 sm:min-h-0 sm:py-0.5"
          >
            Show all
          </button>
        </div>
      ) : null}
    </div>
  );
}

MinimalGraphHud.propTypes = {
  zoomLevel: PropTypes.number.isRequired,
  clusterLevelLabel: PropTypes.string,
  displayMode: PropTypes.string.isRequired,
  effectiveSemanticLevel: PropTypes.number,
  effectiveClusterLevel: PropTypes.number,
  displayNodes: PropTypes.array.isRequired,
  displayEdges: PropTypes.array.isRequired,
  projectionStats: PropTypes.shape({
    projectedPairCount: PropTypes.number.isRequired,
    semanticEdgeCount: PropTypes.number.isRequired,
    internalEdgeCount: PropTypes.number.isRequired,
    unmappedEdgeCount: PropTypes.number.isRequired,
    projectionLimited: PropTypes.bool,
    limitationReason: PropTypes.string,
  }),
  normalizedChunk: PropTypes.array.isRequired,
  lockedLevel: PropTypes.number,
  drilldownPath: PropTypes.array.isRequired,
  setDrilldownPath: PropTypes.func.isRequired,
  legacyClusterLevel: PropTypes.number.isRequired,
  autoFollowRef: PropTypes.shape({ current: PropTypes.bool }).isRequired,
  setAutoFollow: PropTypes.func.isRequired,
  userOverrodeTierRef: PropTypes.shape({ current: PropTypes.bool }).isRequired,
  setLockedLevel: PropTypes.func.isRequired,
  neighborhoodFocus: PropTypes.shape({
    title: PropTypes.string.isRequired,
    directNeighborCount: PropTypes.number.isRequired,
  }),
  clearNeighborhoodFocus: PropTypes.func,
};
