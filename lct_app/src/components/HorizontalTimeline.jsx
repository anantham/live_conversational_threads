import { useState, useEffect, useRef } from "react";

/**
 * HorizontalTimeline Component
 *
 * Displays conversation utterances in a horizontal left-to-right timeline
 * with speaker-based color coding and selection support.
 *
 * Props:
 * - conversationId: ID of the conversation
 * - utterances: Array of utterance objects
 * - selectedUtteranceIds: Array of selected utterance IDs (for highlighting)
 * - onUtteranceClick: Callback when an utterance is clicked
 * - highlightedThematicNodes: Array of thematic node IDs that should highlight their utterances
 * - selectedThematicNodeUtterances: Array of utterance objects from selected thematic node (for timestamp bubbles)
 */
export default function HorizontalTimeline({
  conversationId,
  utterances = [],
  selectedUtteranceIds = [],
  onUtteranceClick,
  highlightedThematicNodes = [],
  selectedThematicNodeUtterances = [],
}) {
  const [detailViewUtterance, setDetailViewUtterance] = useState(null); // For side drawer
  const timelineRef = useRef(null);

  // Scroll to a specific utterance by ID
  const scrollToUtterance = (utteranceId) => {
    const utteranceIndex = utterances.findIndex(u => u.id === utteranceId);
    if (utteranceIndex !== -1 && timelineRef.current) {
      // Each card is 192px wide (w-48 = 12rem = 192px) + 8px gap
      const scrollPosition = utteranceIndex * 200;
      timelineRef.current.scrollLeft = scrollPosition;
    }
  };

  // Generate distinct colors for speakers
  const getSpeakerColor = (speakerName) => {
    const colors = [
      { bg: "bg-blue-100", border: "border-blue-400", text: "text-blue-900" },
      { bg: "bg-green-100", border: "border-green-400", text: "text-green-900" },
      { bg: "bg-purple-100", border: "border-purple-400", text: "text-purple-900" },
      { bg: "bg-pink-100", border: "border-pink-400", text: "text-pink-900" },
      { bg: "bg-yellow-100", border: "border-yellow-400", text: "text-yellow-900" },
      { bg: "bg-indigo-100", border: "border-indigo-400", text: "text-indigo-900" },
      { bg: "bg-red-100", border: "border-red-400", text: "text-red-900" },
      { bg: "bg-teal-100", border: "border-teal-400", text: "text-teal-900" },
    ];

    // Simple hash function to assign consistent colors
    let hash = 0;
    for (let i = 0; i < speakerName.length; i++) {
      hash = speakerName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  };

  // Format timestamp for display
  const formatTimestamp = (seconds) => {
    if (!seconds && seconds !== 0) return "";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  // Handle card click to open detail drawer
  const handleCardClick = (utterance, event) => {
    // Find the text element to check if it's truncated
    const cardElement = event.currentTarget;
    const textElement = cardElement.querySelector('.line-clamp-5');

    if (textElement) {
      // Check if text is truncated by comparing scroll height vs client height
      const isTruncated = textElement.scrollHeight > textElement.clientHeight;

      console.log('[HorizontalTimeline] Card clicked:', {
        utteranceId: utterance.id,
        textLength: utterance.text?.length,
        isTruncated,
        scrollHeight: textElement.scrollHeight,
        clientHeight: textElement.clientHeight
      });

      // Only open sidebar if text is truncated
      if (!isTruncated) {
        console.log('[HorizontalTimeline] Text fits in card - skipping sidebar');
        // Still call onUtteranceClick for highlighting purposes
        if (onUtteranceClick) {
          onUtteranceClick(utterance);
        }
        return;
      }
    }

    // Text is truncated or couldn't determine - open sidebar
    console.log('[HorizontalTimeline] Opening sidebar for full text');
    setDetailViewUtterance(utterance);
    if (onUtteranceClick) {
      onUtteranceClick(utterance);
    }
  };

  // Check if utterance is selected
  const isUtteranceSelected = (utteranceId) => {
    return selectedUtteranceIds.includes(utteranceId);
  };

  // Check if utterance is part of highlighted thematic nodes
  const isUtteranceHighlighted = (utteranceId) => {
    // This will be implemented when we connect with thematic data
    return false;
  };

  if (!utterances || utterances.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>No utterances available</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Timeline Header */}
      <div className="flex items-center justify-between mb-2 px-2">
        <h3 className="text-sm font-semibold text-gray-700">
          Conversation Timeline ({utterances.length} utterances)
        </h3>
      </div>

      {/* Timestamp Bubbles (when thematic node is selected) */}
      {selectedThematicNodeUtterances && selectedThematicNodeUtterances.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-2">
          <span className="text-xs text-gray-600 font-semibold self-center">
            Jump to:
          </span>
          {selectedThematicNodeUtterances.map((utt) => (
            <button
              key={utt.id}
              onClick={() => scrollToUtterance(utt.id)}
              className="px-3 py-1 text-xs bg-orange-100 border-2 border-orange-500 text-orange-900 rounded-full hover:bg-orange-200 hover:shadow-md transition-all duration-200 font-mono"
              title={`${utt.speaker_name || utt.speaker_id}: ${utt.text.substring(0, 50)}...`}
            >
              {formatTimestamp(utt.timestamp_start)}
            </button>
          ))}
        </div>
      )}

      {/* Horizontal Scrollable Timeline */}
      <div
        ref={timelineRef}
        className="flex-grow overflow-x-auto overflow-y-hidden"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="flex gap-2 p-2 h-full items-center">
          {utterances.map((utterance, index) => {
            const speakerName = utterance.speaker_name || utterance.speaker_id || "Unknown";
            const speakerColors = getSpeakerColor(speakerName);
            const isSelected = isUtteranceSelected(utterance.id);
            const isHighlighted = isUtteranceHighlighted(utterance.id);

            // Determine styling based on state
            let borderClass = speakerColors.border;
            let bgClass = speakerColors.bg;
            let shadowClass = "";

            if (isSelected) {
              borderClass = "border-orange-500";
              bgClass = "bg-orange-100";
              shadowClass = "shadow-lg";
            } else if (isHighlighted) {
              borderClass = "border-blue-500";
              bgClass = "bg-blue-100";
              shadowClass = "shadow-md";
            }

            return (
              <div
                key={utterance.id}
                className={`
                  flex-shrink-0 w-48 h-32 p-2 rounded-lg border-2
                  ${bgClass} ${borderClass} ${shadowClass}
                  cursor-pointer transition-all duration-200
                  hover:scale-105
                `}
                onClick={(e) => handleCardClick(utterance, e)}
              >
                {/* Speaker & Timestamp */}
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-bold ${speakerColors.text} truncate`}>
                    {speakerName}
                  </span>
                  <span className="text-xs text-gray-600">
                    {formatTimestamp(utterance.timestamp_start)}
                  </span>
                </div>

                {/* Utterance Text */}
                <div className="text-xs text-gray-700 overflow-hidden h-20">
                  <p className="line-clamp-5">{utterance.text}</p>
                </div>

                {/* Sequence Number (bottom-right corner) */}
                <div className="flex justify-end mt-1">
                  <span className="text-xs text-gray-500">#{utterance.sequence_number}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline Navigation Helper */}
      <div className="flex items-center justify-center gap-2 mt-2 px-2">
        <button
          onClick={() => {
            if (timelineRef.current) {
              timelineRef.current.scrollLeft -= 400;
            }
          }}
          className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded-md transition"
        >
          ← Previous
        </button>
        <button
          onClick={() => {
            if (timelineRef.current) {
              timelineRef.current.scrollLeft += 400;
            }
          }}
          className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded-md transition"
        >
          Next →
        </button>
      </div>

      {/* Side Drawer for Detail View */}
      {detailViewUtterance && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black bg-opacity-30 z-40"
            onClick={() => setDetailViewUtterance(null)}
          />

          {/* Drawer */}
          <div className="fixed right-0 top-0 h-full w-full md:w-1/3 bg-white shadow-2xl z-50 overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">
                    {detailViewUtterance.speaker_name || detailViewUtterance.speaker_id}
                  </h3>
                  <p className="text-sm text-gray-500">
                    Sequence #{detailViewUtterance.sequence_number} • {formatTimestamp(detailViewUtterance.timestamp_start)}
                  </p>
                </div>
                <button
                  onClick={() => setDetailViewUtterance(null)}
                  className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
                >
                  ×
                </button>
              </div>

              {/* Full Text */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Full Text</h4>
                <div className="text-sm text-gray-800 leading-relaxed bg-gray-50 p-4 rounded-lg">
                  {detailViewUtterance.text}
                </div>
              </div>

              {/* Metadata */}
              <div className="space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Duration</h4>
                  <p className="text-sm text-gray-800">
                    {formatTimestamp(detailViewUtterance.timestamp_start)} - {formatTimestamp(detailViewUtterance.timestamp_end)}
                    {detailViewUtterance.timestamp_end && detailViewUtterance.timestamp_start && (
                      <span className="text-gray-500 ml-2">
                        ({Math.round(detailViewUtterance.timestamp_end - detailViewUtterance.timestamp_start)}s)
                      </span>
                    )}
                  </p>
                </div>

                {detailViewUtterance.entities && detailViewUtterance.entities.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Entities</h4>
                    <div className="flex flex-wrap gap-2">
                      {detailViewUtterance.entities.map((entity, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full"
                        >
                          {entity}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="mt-6 pt-6 border-t flex gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(detailViewUtterance.text);
                    alert('Text copied to clipboard!');
                  }}
                  className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition text-sm font-semibold"
                >
                  Copy Text
                </button>
                <button
                  onClick={() => setDetailViewUtterance(null)}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm font-semibold"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
