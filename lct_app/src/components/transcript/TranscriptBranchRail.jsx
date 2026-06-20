import PropTypes from "prop-types";
import { GitBranch } from "lucide-react";

const BRANCH_STYLES = [
  { dot: "bg-teal-500", border: "border-teal-200", text: "text-teal-800", bg: "bg-teal-50/70" },
  { dot: "bg-sky-500", border: "border-sky-200", text: "text-sky-800", bg: "bg-sky-50/70" },
  { dot: "bg-indigo-500", border: "border-indigo-200", text: "text-indigo-800", bg: "bg-indigo-50/70" },
  { dot: "bg-purple-500", border: "border-purple-200", text: "text-purple-800", bg: "bg-purple-50/70" },
  { dot: "bg-slate-500", border: "border-slate-200", text: "text-slate-800", bg: "bg-slate-50/70" },
  { dot: "bg-emerald-500", border: "border-emerald-200", text: "text-emerald-800", bg: "bg-emerald-50/70" },
  { dot: "bg-cyan-500", border: "border-cyan-200", text: "text-cyan-800", bg: "bg-cyan-50/70" },
];

export default function TranscriptBranchRail({ branches }) {
  if (!Array.isArray(branches) || branches.length < 2) return null;

  return (
    <div className="shrink-0 border-b border-gray-200 bg-white/70 px-4 py-2">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-gray-400">
        <GitBranch size={12} />
        <span>Threads</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {branches.map((branch) => {
          const style = BRANCH_STYLES[branch.colorIndex % BRANCH_STYLES.length];
          return (
            <div
              key={branch.id}
              className={`min-w-[10rem] max-w-[15rem] rounded-md border ${style.border} ${style.bg} px-2.5 py-2`}
            >
              <div className="mb-1 flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                <span className={`truncate text-[11px] font-semibold ${style.text}`}>
                  {branch.title}
                </span>
              </div>
              <p className="line-clamp-2 text-[10px] leading-snug text-gray-600">
                {branch.preview}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-gray-400">
                <span>{branch.lineCount} lines</span>
                <span className="truncate">{branch.speakers.join(", ")}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

TranscriptBranchRail.propTypes = {
  branches: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      colorIndex: PropTypes.number.isRequired,
      title: PropTypes.string.isRequired,
      preview: PropTypes.string.isRequired,
      lineCount: PropTypes.number.isRequired,
      speakers: PropTypes.arrayOf(PropTypes.string).isRequired,
    })
  ),
};
