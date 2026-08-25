import { useState } from "react";
import PropTypes from "prop-types";

const TIER = { 1: "moment", 2: "idea", 3: "topic", 4: "theme", 5: "arc" };

function CoverageBadge({ coverage }) {
  if (!coverage || typeof coverage !== "object") return null;
  if (coverage.auditable) {
    const pct = coverage.pct != null ? `${coverage.pct}%` : "linked";
    return (
      <span
        title={`Source coverage: ${coverage.covered_turns}/${coverage.total_turns} raw turns are reachable from a node's source link, so the map can be audited against the transcript.`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
      >
        <span aria-hidden="true">✓</span>
        {pct} audited
        <span className="text-emerald-600/70">
          · {coverage.covered_turns}/{coverage.total_turns}
        </span>
      </span>
    );
  }
  return (
    <span
      title="No node links to specific raw turns (legacy or live capture). You cannot verify these summaries against the transcript — treat the map as unverified."
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
    >
      <span aria-hidden="true">⚠</span>
      unauditable
    </span>
  );
}

CoverageBadge.propTypes = {
  coverage: PropTypes.shape({
    auditable: PropTypes.bool,
    pct: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    covered_turns: PropTypes.number,
    total_turns: PropTypes.number,
  }),
};

export default function ThreadsViewerHeader({
  bundle,
  focusNode,
  libraryStatus,
  onDownloadTranscript,
  onEnterFocus,
  onOpenLibrary,
  onOpenAnother,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const title =
    focusNode?.title ||
    bundle.conversation_title ||
    bundle.conversation_name ||
    "Untitled";
  const summary = focusNode?.summary || bundle.executive_summary || "";
  const eyebrow = focusNode
    ? `Zoomed into ${TIER[focusNode.level] || "a part"} · ${focusNode.depth} level${focusNode.depth > 1 ? "s" : ""} deep`
    : "Conversation map · read-only";

  return (
    <header className="shrink-0 border-b border-slate-200 bg-white/80 px-4 py-2 backdrop-blur">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        {collapsed ? (
          <button
            type="button"
            aria-label="Show conversation overview"
            onClick={() => setCollapsed(false)}
            className="min-w-0 rounded px-2 py-1 text-left text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800"
          >
            <span aria-hidden="true">▸</span> Overview
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">
                {eyebrow}
              </p>
              {libraryStatus && (
                <span
                  className={`text-[10px] font-medium ${
                    libraryStatus.state === "error"
                      ? "text-amber-700"
                      : libraryStatus.state === "saved"
                        ? "text-emerald-700"
                        : "text-slate-500"
                  }`}
                >
                  {libraryStatus.message}
                </span>
              )}
              <CoverageBadge coverage={bundle.coverage} />
            </div>
            <h1 className="truncate text-base font-semibold text-slate-800" title={title}>
              {title}
            </h1>
            {summary && (
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                {summary}
              </p>
            )}
          </div>
        )}

        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
          {!collapsed && (
            <button
              type="button"
              aria-label="Hide conversation overview"
              onClick={() => setCollapsed(true)}
              title="Minimize the title and summary"
              className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              ▴ Hide overview
            </button>
          )}
          <button
            type="button"
            onClick={onDownloadTranscript}
            title="Download the raw transcript reconstructed from the artifact"
            className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            ↓ Transcript
          </button>
          <button
            type="button"
            onClick={onEnterFocus}
            title="Focus mode — hide everything but the nodes (Esc to exit)"
            className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            ⛶ Focus
          </button>
          <button
            type="button"
            onClick={onOpenLibrary}
            className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            Library
          </button>
          <button
            type="button"
            onClick={onOpenAnother}
            className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            Open another
          </button>
        </div>
      </div>
    </header>
  );
}

ThreadsViewerHeader.propTypes = {
  bundle: PropTypes.shape({
    conversation_title: PropTypes.string,
    conversation_name: PropTypes.string,
    executive_summary: PropTypes.string,
    coverage: PropTypes.object,
  }).isRequired,
  focusNode: PropTypes.shape({
    title: PropTypes.string,
    summary: PropTypes.string,
    level: PropTypes.number,
    depth: PropTypes.number,
  }),
  libraryStatus: PropTypes.shape({
    state: PropTypes.string,
    message: PropTypes.string,
  }),
  onDownloadTranscript: PropTypes.func.isRequired,
  onEnterFocus: PropTypes.func.isRequired,
  onOpenLibrary: PropTypes.func.isRequired,
  onOpenAnother: PropTypes.func.isRequired,
};
