import { formatTimestamp } from "./thematicConstants";

/**
 * Bottom panel showing utterances belonging to the selected thematic node.
 */
export default function UtteranceDetailPanel({
  selectedNodeData,
  selectedNodeUtterances,
  showPanel,
  setShowPanel,
  onUtteranceClick,
}) {
  if (!selectedNodeData) return null;

  // Collapsed state — show expand button
  if (!showPanel) {
    return (
      <button
        onClick={() => setShowPanel(true)}
        className="mt-2 px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition"
      >
        📝 Show {selectedNodeUtterances.length} utterances for &quot;{selectedNodeData.label}&quot;
      </button>
    );
  }

  return (
    <div className="flex-1 min-h-[120px] max-h-[200px] border rounded-lg bg-white shadow-sm overflow-hidden flex flex-col mt-2">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">
            📝 Utterances in &quot;{selectedNodeData.label}&quot;
          </span>
          <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
            {selectedNodeUtterances.length} utterances
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {formatTimestamp(selectedNodeData.timestamp_start)} - {formatTimestamp(selectedNodeData.timestamp_end)}
          </span>
          <button
            onClick={() => setShowPanel(false)}
            className="text-gray-400 hover:text-gray-600 px-1"
            title="Hide panel"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Utterance List */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {selectedNodeUtterances.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-4">
            No utterance data available
          </div>
        ) : (
          <div className="space-y-1">
            {selectedNodeUtterances.map((utt) => (
              <div
                key={utt.id}
                onClick={() => onUtteranceClick && onUtteranceClick(utt)}
                className="flex items-start gap-2 p-2 rounded-lg hover:bg-blue-50 cursor-pointer transition group"
              >
                {/* Timestamp Badge */}
                <span className="flex-shrink-0 text-xs font-mono bg-blue-100 text-blue-700 px-2 py-1 rounded group-hover:bg-blue-200">
                  {formatTimestamp(utt.timestamp_start)}
                </span>

                {/* Speaker */}
                <span className="flex-shrink-0 text-xs font-semibold text-purple-600 min-w-[60px]">
                  {utt.speaker_name || utt.speaker_id || 'Speaker'}:
                </span>

                {/* Text */}
                <span className="text-sm text-gray-700 flex-grow line-clamp-2">
                  {utt.text}
                </span>

                {/* Click indicator */}
                <span className="flex-shrink-0 text-gray-300 group-hover:text-blue-500 text-xs">
                  →
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
