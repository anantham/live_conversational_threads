import PropTypes from "prop-types";

export default function UploadTranscriptPreview({ lines }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  return (
    <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1">
      {lines.slice(-3).map((line, index) => (
        <p key={`${index}-${line.slice(0, 24)}`} className="text-[10px] text-gray-500 truncate">
          {line}
        </p>
      ))}
    </div>
  );
}

UploadTranscriptPreview.propTypes = {
  lines: PropTypes.arrayOf(PropTypes.string),
};
