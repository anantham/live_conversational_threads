import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  ChevronDown,
  Download,
  FilePlus2,
  LibraryBig,
  Maximize2,
  RefreshCw,
} from "lucide-react";

import {
  COMPACT_VIEWER_QUERY,
  mediaQueryMatches,
  useMediaQuery,
} from "../../hooks/useMediaQuery";

const TIER = { 1: "moment", 2: "idea", 3: "topic", 4: "theme", 5: "arc" };

function CoverageBadge({ coverage }) {
  if (!coverage || typeof coverage !== "object") return null;
  if (coverage.auditable) {
    const pct = coverage.pct != null ? `${coverage.pct}%` : "linked";
    return (
      <span
        title={`Source coverage: ${coverage.covered_turns}/${coverage.total_turns} raw turns are reachable from a node's source link, so the map can be audited against the transcript.`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700"
      >
        <span aria-hidden="true">✓</span>
        Artifact {pct} linked
        <span className="text-emerald-600/70">
          · {coverage.covered_turns}/{coverage.total_turns}
        </span>
      </span>
    );
  }
  return (
    <span
      title="No node links to specific raw turns (legacy or live capture). You cannot verify these summaries against the transcript — treat the map as unverified."
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700"
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

function ViewerAction({ icon: Icon, label, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className="inline-flex min-h-11 min-w-0 flex-col items-center justify-center gap-0 rounded-md px-1 text-[9px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 sm:min-h-0 sm:flex-row sm:gap-1 sm:px-2 sm:py-1 sm:text-[11px]"
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

ViewerAction.propTypes = {
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  title: PropTypes.string,
};

export default function ThreadsViewerHeader({
  bundle,
  focusNode,
  libraryStatus,
  onDownloadTranscript,
  onEnterFocus,
  onOpenLibrary,
  onOpenAnother,
  onRefreshFromDrive,
}) {
  const compact = useMediaQuery(COMPACT_VIEWER_QUERY);
  const readerChangedOverview = useRef(false);
  const [collapsed, setCollapsed] = useState(() =>
    mediaQueryMatches(COMPACT_VIEWER_QUERY),
  );

  useEffect(() => {
    if (!readerChangedOverview.current) setCollapsed(compact);
  }, [compact]);
  const title =
    focusNode?.title ||
    bundle.conversation_title ||
    bundle.conversation_name ||
    "Untitled";
  const summary = focusNode?.summary || bundle.executive_summary || "";
  const eyebrow = focusNode
    ? `Zoomed into ${TIER[focusNode.level] || "a part"} · ${focusNode.depth} level${focusNode.depth > 1 ? "s" : ""} deep`
    : "Conversation map · read-only";

  const toggleOverview = () => {
    readerChangedOverview.current = true;
    setCollapsed((value) => !value);
  };

  return (
    <header
      className="t-acc shrink-0 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur sm:px-4"
      data-open={String(!collapsed)}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <p className="hidden min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500 sm:block">
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
          <h1
            className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-slate-800 sm:truncate sm:text-base"
            title={title}
          >
            {title}
          </h1>
          {summary && (
            <div
              className="t-acc-panel"
              aria-hidden={collapsed}
              inert={collapsed ? "" : undefined}
            >
              <div className="t-acc-panel-inner">
                <p className="mt-1 max-w-[75ch] text-xs leading-relaxed text-slate-600">
                  {summary}
                </p>
              </div>
            </div>
          )}
        </div>

        <nav
          aria-label="Conversation viewer actions"
          className={`grid w-full shrink-0 gap-1 border-t border-slate-100 pt-1 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end sm:border-0 sm:pt-0 ${
            onRefreshFromDrive ? "grid-cols-6" : "grid-cols-5"
          }`}
        >
          <button
            type="button"
            aria-label={collapsed ? "Show conversation overview" : "Hide conversation overview"}
            aria-expanded={!collapsed}
            onClick={toggleOverview}
            title={collapsed ? "Show the conversation summary" : "Hide the conversation summary"}
            className="inline-flex min-h-11 min-w-0 flex-col items-center justify-center gap-0 rounded-md px-1 text-[9px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 sm:min-h-0 sm:flex-row sm:gap-1 sm:px-2 sm:py-1 sm:text-[11px]"
          >
            <span className="t-acc-chevron">
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{collapsed ? "Overview" : "Hide"}</span>
          </button>
          <ViewerAction
            icon={Download}
            label="Transcript"
            onClick={onDownloadTranscript}
            title="Download the raw transcript reconstructed from the artifact"
          />
          <ViewerAction
            icon={Maximize2}
            label="Focus"
            onClick={onEnterFocus}
            title="Focus mode — hide everything but the nodes (Esc to exit)"
          />
          <ViewerAction icon={LibraryBig} label="Library" onClick={onOpenLibrary} />
          {onRefreshFromDrive && (
            <ViewerAction
              icon={RefreshCw}
              label="Refresh"
              onClick={onRefreshFromDrive}
              title="Check Google Drive for an updated conversation map"
            />
          )}
          <ViewerAction icon={FilePlus2} label="Open" onClick={onOpenAnother} title="Open another .threads file" />
        </nav>
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
  onRefreshFromDrive: PropTypes.func,
};
