import { useRef, useEffect } from "react";
import PropTypes from "prop-types";

export default function TranscriptCard({ selectedNode, selectedNodeData, chunkDict, latestChunk }) {
  const highlightRef = useRef(null);

  // Auto-scroll to highlighted section when this card mounts or selectedNode changes
  useEffect(() => {
    if (highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [selectedNode]);

  const chunkId = selectedNodeData?.chunk_id;
  const transcript = chunkDict?.[chunkId] || "Transcript not available";
  const selectedTurnText = selectedNodeData?.full_text || "";

  const transcriptLines = transcript.split("\n");
  const selectedLines = selectedTurnText.split("\n");

  // Find which occurrence this turn is (handles duplicate text)
  const currentNodeIndex = latestChunk.findIndex((n) => n.id === selectedNode);
  let occurrenceNumber = 0;
  for (let i = 0; i < currentNodeIndex; i++) {
    if (latestChunk[i].full_text === selectedTurnText) {
      occurrenceNumber++;
    }
  }

  // Find the Nth occurrence of this text in the transcript
  let startIndex = -1;
  let foundOccurrences = 0;
  if (selectedLines.length > 0 && selectedLines[0].trim()) {
    const searchPattern = selectedLines[0].trim().substring(0, 30);
    for (let i = 0; i < transcriptLines.length; i++) {
      if (transcriptLines[i].includes(searchPattern)) {
        if (foundOccurrences === occurrenceNumber) {
          startIndex = i;
          break;
        }
        foundOccurrences++;
      }
    }
  }

  return (
    <div className="p-4 border rounded-lg bg-purple-100 shadow-md mb-2 z-20 max-h-[300px] overflow-y-auto">
      <h3 className="font-semibold text-black mb-2">Full Transcript (highlighted turn below)</h3>
      <div className="text-sm text-black whitespace-pre-wrap">
        {transcriptLines.map((line, index) => {
          const isHighlighted =
            startIndex !== -1 && index >= startIndex && index < startIndex + selectedLines.length;

          return (
            <div
              key={index}
              ref={isHighlighted && index === startIndex ? highlightRef : null}
              className={isHighlighted ? "bg-yellow-300 font-semibold p-1 rounded" : ""}
            >
              {line || "\u00A0"}
            </div>
          );
        })}
      </div>
    </div>
  );
}

TranscriptCard.propTypes = {
  selectedNode: PropTypes.string.isRequired,
  selectedNodeData: PropTypes.object,
  chunkDict: PropTypes.object,
  latestChunk: PropTypes.array.isRequired,
};
