import PropTypes from "prop-types";

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
  normalizedChunk,
  lockedLevel,
  semanticCountLabel,
  drilldownPath,
  setDrilldownPath,
  legacyClusterLevel,
  autoFollowRef,
  setAutoFollow,
  userOverrodeTierRef,
  setLockedLevel,
}) {
  const tierSpecs = displayMode === "semantic" ? AUTHORED_LEVELS : LEGACY_TIER_SPECS;

  return (
    <div className="absolute top-3 left-3 right-3 z-40 flex items-center gap-2 select-none overflow-x-auto flex-nowrap whitespace-nowrap">
      <div className="flex-shrink-0 flex items-center gap-1.5 rounded-md bg-white/95 border border-gray-200 shadow-sm px-2.5 py-1.5">
        <span className="text-[10px] font-mono text-gray-500">{Math.round(zoomLevel * 100)}%</span>
        <span className="text-[9px] text-gray-300">|</span>
        {clusterLevelLabel ? (
          <>
            <span className={`text-[10px] font-semibold ${
              displayMode === "semantic"
                ? (AUTHORED_LEVELS.find((spec) => spec.level === effectiveSemanticLevel)?.color || "text-blue-600")
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
                ? semanticCountLabel
                : `${displayNodes.length} clusters · ${normalizedChunk.length} nodes`}
            </span>
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

      <div className="flex-shrink-0 flex items-center gap-0 rounded-md bg-white/95 border border-gray-200 shadow-sm overflow-hidden">
        {tierSpecs.map(({ label, level, chip, border, color }) => {
          const isActive = displayMode === "semantic"
            ? effectiveSemanticLevel === level
            : legacyClusterLevel === level;
          const isLocked = lockedLevel === level;
          return (
            <button
              key={label}
              onClick={() => {
                autoFollowRef.current = false;
                setAutoFollow(false);
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
              className={`px-2 py-1 text-[9px] font-medium transition-colors cursor-pointer ${
                isActive
                  ? `${chip} ${color} border-b-2 ${border}`
                  : isLocked
                  ? `${chip} ${color} border-b-2 border-dashed ${border}`
                  : "text-gray-500 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              {label}{isLocked ? " \u{1F512}" : ""}
            </button>
          );
        })}
      </div>
      {lockedLevel != null && (
        <button
          onClick={() => setLockedLevel(null)}
          className="text-[9px] text-gray-500 hover:text-gray-600 ml-1"
          title="Unlock zoom level"
        >
          unlock
        </button>
      )}
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
  normalizedChunk: PropTypes.array.isRequired,
  lockedLevel: PropTypes.number,
  semanticCountLabel: PropTypes.string,
  drilldownPath: PropTypes.array.isRequired,
  setDrilldownPath: PropTypes.func.isRequired,
  legacyClusterLevel: PropTypes.number.isRequired,
  autoFollowRef: PropTypes.shape({ current: PropTypes.bool }).isRequired,
  setAutoFollow: PropTypes.func.isRequired,
  userOverrodeTierRef: PropTypes.shape({ current: PropTypes.bool }).isRequired,
  setLockedLevel: PropTypes.func.isRequired,
};