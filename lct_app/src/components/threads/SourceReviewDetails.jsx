import { useId, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { createSourceReviewSelector } from "../../services/sourceReviews";

const label = (value) => typeof value === "string" ? value.replaceAll("_", " ") : "unavailable";

function Evidence({ rows = [] }) {
  return rows.map((row, index) => (
    <figure key={index} className="mt-2 rounded border border-slate-100 bg-slate-50 p-2">
      <blockquote className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{row.quote}</blockquote>
      <figcaption className="mt-1 break-all text-xs text-slate-500">
        Source {row.sourceId}{row.nodeId ? ` · moment ${row.nodeId}` : ""}
        {row.utteranceIds?.length > 0 ? ` · turns ${row.utteranceIds.join(", ")}` : ""}
      </figcaption>
    </figure>
  ));
}
Evidence.propTypes = { rows: PropTypes.arrayOf(PropTypes.object) };

export default function SourceReviewDetails({ bundle, nodeId, reviewSelector }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState({ nodeId, bundle });
  const contentId = useId();
  // Reset before committing the new selection, not in a post-paint effect.
  if (selection.nodeId !== nodeId || selection.bundle !== bundle) {
    setSelection({ nodeId, bundle });
    setOpen(false);
  }
  const select = useMemo(() => reviewSelector || createSourceReviewSelector(bundle), [bundle, reviewSelector]);
  const reviews = useMemo(() => select(nodeId), [select, nodeId]);
  const groups = useMemo(() => {
    const policies = new Map();
    for (const [kind, rows] of [["question", reviews.questions], ["thread", reviews.threads]]) {
      for (const row of rows) {
        const key = row.policyFingerprint;
        if (!policies.has(key)) policies.set(key, []);
        policies.get(key).push({ kind, row });
      }
    }
    return [...policies.entries()];
  }, [reviews]);
  const count = reviews.questions.length + reviews.threads.length;
  if (!count && !reviews.invalidCount) return null;
  return (
    <section className="mt-4 border-t border-slate-200 pt-2">
      <button type="button" aria-expanded={open} aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="min-h-11 rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
        Source reviews{count ? ` (${count})` : ""}
      </button>
      {open && (
        <div id={contentId} className="space-y-4 pb-2">
          <p className="text-xs leading-relaxed text-slate-500">Model interpretation, not human-verified. Original threads and question history are unchanged.</p>
          {groups.map(([policy, items], index) => (
            <section key={policy} aria-label={`Review policy ${index + 1}`} className="space-y-3">
              <h3 className="text-xs font-medium text-slate-600">Review policy {index + 1}</h3>
              <p className="break-all font-mono text-[10px] text-slate-500">{policy}</p>
              {items.map(({ kind, row }, itemIndex) => (
                <div key={`${kind}:${itemIndex}`} className="space-y-1">
                  {kind === "question" ? (
                    <>
                      <h4 className="text-sm font-medium text-slate-800">{row.originalWording || `Question ${row.id}`}</h4>
                      <p className="text-xs text-slate-600">Originally recorded: {label(row.provisionalStatus)} · Reviewed: {label(row.status)}</p>
                    </>
                  ) : (
                    <>
                      <h4 className="text-sm font-medium text-slate-800">Thread relationship: {label(row.judgment)}</h4>
                      <p className="break-all text-xs text-slate-500">Moments {row.pair?.join(" · ")}</p>
                    </>
                  )}
                  {row.rationale && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">{row.rationale}</p>}
                  <Evidence rows={row.evidence} />
                </div>
              ))}
            </section>
          ))}
          {reviews.invalidCount > 0 && <p className="text-xs text-slate-500">Some review data could not be matched to this artifact and is not shown.</p>}
        </div>
      )}
    </section>
  );
}
SourceReviewDetails.propTypes = { bundle: PropTypes.object, nodeId: PropTypes.string, reviewSelector: PropTypes.func };
