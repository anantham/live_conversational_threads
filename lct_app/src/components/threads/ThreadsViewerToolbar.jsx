import { useRef } from "react";
import PropTypes from "prop-types";
import { ArrowLeft, ArrowRight, ChevronRight, Download, Focus, FolderOpen, Network, MessageSquare, Layers, FilePlus2, RefreshCw, FileVideo } from "lucide-react";
import ViewerFindMenu from "./ViewerFindMenu";
import TooltipButton from "../TooltipButton";

const buttonClass = "min-h-11 rounded px-3 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700";
const secondaryButtonClass = `${buttonClass} text-slate-700`;
const historyButtonClass = "inline-flex h-11 w-11 shrink-0 items-center justify-center p-0 text-slate-700 enabled:hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 disabled:cursor-default disabled:text-slate-500 sm:h-8 sm:w-6";
const viewIcons = { graph: Network, discussion: MessageSquare, cards: Layers };
const actionItems = [
  ["Download transcript", "download", Download],
  ["Focus graph", "focus", Focus],
  ["Library", "library", FolderOpen],
  ["Open another file", "another", FilePlus2],
  ["Refresh from Drive", "refresh", RefreshCw],
];
const titleCase = (value) => value[0].toUpperCase() + value.slice(1);

export function ViewerModeButton({ viewMode, modes, onViewModeChange }) {
  const nextMode = modes[(modes.indexOf(viewMode) + 1) % modes.length];
  const CurrentViewIcon = viewIcons[viewMode] || Layers;
  return <div role="group" aria-label="Conversation view" className="flex gap-1">
    <button type="button" aria-label={`Current view: ${titleCase(viewMode)}. Switch to ${titleCase(nextMode)} view.`}
      onClick={() => onViewModeChange(nextMode)}
      title={`Switch to ${titleCase(nextMode)} view`}
      className="inline-flex min-h-11 items-center gap-1 rounded border border-slate-200 bg-white px-3 py-1 text-[10px] font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 sm:min-h-0 sm:px-2">
      <CurrentViewIcon aria-hidden="true" size={16} />
      <span>{titleCase(viewMode)}</span>
      <span className="sr-only">Switch to {titleCase(nextMode)} view</span>
    </button>
  </div>;
}
ViewerModeButton.propTypes = { viewMode: PropTypes.string.isRequired, modes: PropTypes.arrayOf(PropTypes.string).isRequired, onViewModeChange: PropTypes.func.isRequired };

export default function ThreadsViewerToolbar({
  viewMode, modes, onViewModeChange, graphToolsRef, graphTierRef, findGroups, onFindNode, searchDocuments, onSearchResult,
  history,
  sourceAvailable, sourceOpen, onToggleSource,
  onDownloadTranscript, onEnterFocus, onOpenLibrary, onOpenAnother, onRefreshFromDrive,
  cardSettings, libraryStatus, coverage,
}) {
  const moreMenu = useRef(null);
  return <div role="toolbar" aria-label="Conversation tools" className="relative z-50 flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-2 py-1 sm:px-4">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {history && <nav aria-label="Exploration history" className="flex shrink-0 items-center rounded-md border border-slate-200 bg-slate-50">
        <TooltipButton aria-label="Back" tooltip={`Back through your exploration history. Return to the previous node, thread or view you visited. Alt + Left.${!history.canBack ? " No earlier exploration yet." : ""}`} disabled={!history.canBack} onClick={history.goBack} className={`${historyButtonClass} rounded-l border-r border-slate-200`}><ArrowLeft aria-hidden="true" className="shrink-0" size={18} /></TooltipButton>
        <TooltipButton aria-label="Forward" tooltip={`Forward through your exploration history. Return to a view you left with Back. Alt + Right.${!history.canForward ? " No later exploration to return to." : ""}`} disabled={!history.canForward} onClick={history.goForward} className={`${historyButtonClass} rounded-r`}><ArrowRight aria-hidden="true" className="shrink-0" size={18} /></TooltipButton>
      </nav>}
      <ViewerFindMenu groups={findGroups} onSelect={onFindNode} documents={searchDocuments} onResult={onSearchResult} />
      <div ref={graphToolsRef} className="flex min-w-0 items-center gap-1" />
      <ViewerModeButton viewMode={viewMode} modes={modes} onViewModeChange={onViewModeChange} />
    </div>
    <div className="flex shrink-0 items-center justify-end gap-1">
      {sourceAvailable && <button type="button" className={`${secondaryButtonClass} flex w-11 items-center justify-center px-0`} aria-label="Source" title={sourceOpen ? "Hide source" : "Show source"} aria-pressed={sourceOpen} onClick={onToggleSource}><FileVideo aria-hidden="true" size={18} /></button>}
      <details key={viewMode} ref={moreMenu} className="group relative">
        <summary className={`${secondaryButtonClass} flex min-h-11 cursor-pointer list-none items-center gap-2`}><ChevronRight aria-hidden="true" size={16} className="transition-transform group-open:rotate-90" />More</summary>
        <div className="fixed right-3 top-3 z-[70] max-h-[calc(100dvh-1.5rem)] w-[min(15rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <div className="flex items-center justify-between px-3 text-xs font-medium text-slate-600">
            <span>More tools</span>
            <button type="button" onClick={() => { moreMenu.current.open = false; }} className="min-h-11 rounded px-2 hover:bg-slate-100">Close</button>
          </div>
          {actionItems.map(([label, action, Icon]) => {
            const handler = { download: onDownloadTranscript, focus: onEnterFocus, library: onOpenLibrary, another: onOpenAnother, refresh: onRefreshFromDrive }[action];
            return handler && <button key={action} type="button" onClick={handler} className={`${secondaryButtonClass} flex w-full items-center gap-3 text-left`}><Icon aria-hidden="true" size={16} className="shrink-0"/><span>{label}</span></button>;
          })}
          {cardSettings && <div className="border-t border-slate-100 py-2">{cardSettings}</div>}
          {(coverage || libraryStatus) && <details className="group border-t border-slate-100 pt-2 text-xs text-slate-600">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2"><ChevronRight aria-hidden="true" size={16} className="shrink-0 transition-transform group-open:rotate-90"/><span>Artifact details</span></summary>
            {coverage?.auditable && <p>Source links: {coverage.covered_turns} of {coverage.total_turns} turns</p>}
            {coverage && !coverage.auditable && <p>Source links unavailable for this artifact.</p>}
            {libraryStatus && <p>{libraryStatus.message}</p>}
          </details>}
        </div>
      </details>
    </div>
    {viewMode === "graph" && <div ref={graphTierRef} className="w-full min-w-0 overflow-x-auto" />}
  </div>;
}

ThreadsViewerToolbar.propTypes = {
  viewMode: PropTypes.string.isRequired,
  modes: PropTypes.arrayOf(PropTypes.string).isRequired,
  onViewModeChange: PropTypes.func.isRequired,
  graphToolsRef: PropTypes.func,
  graphTierRef: PropTypes.func,
  findGroups: PropTypes.array.isRequired,
  onFindNode: PropTypes.func.isRequired,
  searchDocuments: PropTypes.array,
  onSearchResult: PropTypes.func,
  history: PropTypes.shape({canBack: PropTypes.bool, canForward: PropTypes.bool, goBack: PropTypes.func, goForward: PropTypes.func}),
  sourceAvailable: PropTypes.bool,
  sourceOpen: PropTypes.bool,
  onToggleSource: PropTypes.func.isRequired,
  onDownloadTranscript: PropTypes.func.isRequired,
  onEnterFocus: PropTypes.func.isRequired,
  onOpenLibrary: PropTypes.func.isRequired,
  onOpenAnother: PropTypes.func.isRequired,
  onRefreshFromDrive: PropTypes.func,
  cardSettings: PropTypes.node,
  libraryStatus: PropTypes.object,
  coverage: PropTypes.object,
};
