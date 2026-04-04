import { useEffect, useRef } from "react";
import PropTypes from "prop-types";

export default function UploadTranscriptPreview({ lines }) {
  const scrollRef = useRef(null);
  const lineCount = Array.isArray(lines) ? lines.length : 0;

  // Auto-scroll to bottom as new lines arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lineCount]);

  if (lineCount === 0) return null;

  // Show last 6 entries in the compact sidebar view
  const recent = lines.slice(-6);

  return (
    <div
      ref={scrollRef}
      className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 max-h-32 overflow-y-auto"
    >
      {recent.map((entry, index) => {
        const text = typeof entry === "string" ? entry : entry.text;
        const key = `${index}-${text.slice(0, 24)}`;
        return (
          <p key={key} className="text-[10px] text-gray-500 truncate">
            {text}
          </p>
        );
      })}
    </div>
  );
}

UploadTranscriptPreview.propTypes = {
  lines: PropTypes.arrayOf(
    PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.shape({ text: PropTypes.string.isRequired }),
    ])
  ),
};
