import { LEVEL_COLORS, LEVEL_NAMES } from "./thematicConstants";

/**
 * Level navigation bar with prev/next buttons and numbered level buttons.
 */
export default function LevelSelector({
  currentLevel,
  availableLevels,
  levelCounts,
  isLoadingLevel,
  onLevelChange,
  onPreviousLevel,
  onNextLevel,
  canGoPrevious,
  canGoNext,
}) {
  return (
    <div className="flex items-center gap-1">
      {/* Previous Level Button */}
      <button
        onClick={onPreviousLevel}
        disabled={!canGoPrevious || isLoadingLevel}
        className={`px-2 py-1 rounded-l-lg text-sm font-bold transition ${
          canGoPrevious && !isLoadingLevel
            ? "bg-gray-200 hover:bg-gray-300 text-gray-700"
            : "bg-gray-100 text-gray-400 cursor-not-allowed"
        }`}
        title="Previous detail level (more abstract)"
      >
        ◀ Less
      </button>

      {/* Level Buttons */}
      <div className="flex items-center bg-white rounded-lg shadow-inner border border-gray-200">
        {[0, 1, 2, 3, 4, 5].map((level) => {
          const isAvailable = availableLevels.includes(level);
          const isCurrent = level === currentLevel;
          const colors = LEVEL_COLORS[level];
          const count = levelCounts[level] || 0;

          return (
            <button
              key={level}
              onClick={() => onLevelChange(level)}
              disabled={!isAvailable || isLoadingLevel}
              className={`
                relative px-3 py-1.5 text-xs font-semibold transition-all duration-200
                ${isCurrent
                  ? `${colors.bg} text-white shadow-md ring-2 ${colors.ring} z-10`
                  : isAvailable
                    ? `bg-white ${colors.text} hover:bg-gray-50`
                    : "bg-gray-50 text-gray-300 cursor-not-allowed"
                }
                ${level === 0 ? "rounded-l" : ""}
                ${level === 5 ? "rounded-r" : ""}
              `}
              title={isAvailable
                ? `${LEVEL_NAMES[level]} (${count} themes)`
                : `${LEVEL_NAMES[level]} - Not generated yet`
              }
            >
              <span className="block">{level}</span>
              {isAvailable && (
                <span className={`block text-[9px] ${isCurrent ? "text-white/80" : "text-gray-400"}`}>
                  {count}
                </span>
              )}
              {!isAvailable && (
                <span className="block text-[9px] text-gray-300">—</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Next Level Button */}
      <button
        onClick={onNextLevel}
        disabled={!canGoNext || isLoadingLevel}
        className={`px-2 py-1 rounded-r-lg text-sm font-bold transition ${
          canGoNext && !isLoadingLevel
            ? "bg-gray-200 hover:bg-gray-300 text-gray-700"
            : "bg-gray-100 text-gray-400 cursor-not-allowed"
        }`}
        title="Next detail level (more granular)"
      >
        More ▶
      </button>
    </div>
  );
}
