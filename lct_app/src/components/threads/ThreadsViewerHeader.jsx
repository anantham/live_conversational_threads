import PropTypes from "prop-types";

export default function ThreadsViewerHeader({ bundle, focusNode, libraryStatus, overviewOpen = false, onToggleOverview }) {
  const title = bundle.conversation_title || bundle.conversation_name || "Untitled";
  const summary = bundle.executive_summary || focusNode?.summary || "";
  return <header data-viewer-scroll="overview" className="max-h-[32dvh] shrink-0 overflow-y-auto border-b border-slate-200 bg-white px-3 py-2 sm:px-5">
    <h1 className="text-sm font-semibold leading-snug text-slate-800 sm:text-base" title={title}>
      {summary && onToggleOverview ? <button type="button" aria-label={`Conversation overview: ${title}`} aria-expanded={overviewOpen} onClick={onToggleOverview} className="block w-full rounded text-left hover:text-amber-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700"><span className="line-clamp-2 sm:truncate">{title}</span></button> : title}
    </h1>
    {overviewOpen && summary && <p className="mt-2 max-w-[75ch] text-sm leading-6 text-slate-600">{summary}</p>}
    {libraryStatus?.state === "error" && <p role="alert" className="mt-2 text-xs text-amber-800">{libraryStatus.message}</p>}
  </header>;
}

ThreadsViewerHeader.propTypes = {
  bundle: PropTypes.shape({
    conversation_title: PropTypes.string,
    conversation_name: PropTypes.string,
    executive_summary: PropTypes.string,
  }).isRequired,
  focusNode: PropTypes.shape({ title: PropTypes.string, summary: PropTypes.string }),
  libraryStatus: PropTypes.shape({ state: PropTypes.string, message: PropTypes.string }),
  overviewOpen: PropTypes.bool,
  onToggleOverview: PropTypes.func,
};
