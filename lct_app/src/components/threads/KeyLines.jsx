// Test intent: lct_app/tests/intent/ranked-evidence.md
import PropTypes from "prop-types";

/** A node's few strongest cited lines, verbatim; each opens the source at exactly that line. */
export default function KeyLines({ lines, nodeId, nodeTitle, onOpenVisit }) {
  if (!lines?.length) return null;
  return (
    <section aria-label={`Key lines for ${nodeTitle}`}>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={line.utteranceId}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenVisit?.({ nodeId, utteranceId: line.utteranceId, endUtteranceId: line.utteranceId, seconds: line.startSeconds });
              }}
              title={`Open source at ${line.label}`}
              className="block w-full rounded-md px-2 py-1 text-left text-[13px] leading-5 text-slate-700 transition-colors hover:bg-stone-200/60 focus-visible:outline-2 focus-visible:outline-slate-700"
            >
              <span className="line-clamp-2">“{line.text}”</span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                {line.speaker ? `${line.speaker} · ` : ""}
                <span className="font-mono tabular-nums">{line.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

KeyLines.propTypes = {
  lines: PropTypes.arrayOf(
    PropTypes.shape({
      utteranceId: PropTypes.string.isRequired,
      speaker: PropTypes.string,
      text: PropTypes.string.isRequired,
      startSeconds: PropTypes.number,
      label: PropTypes.string.isRequired,
    }),
  ),
  nodeId: PropTypes.string.isRequired,
  nodeTitle: PropTypes.string.isRequired,
  onOpenVisit: PropTypes.func,
};
