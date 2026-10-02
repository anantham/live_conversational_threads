import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Search, X } from 'lucide-react';
import useConversationSearch from '../../hooks/useConversationSearch';
import { searchConversationText } from '../../services/conversationSearch';
import { estimateSearchRemaining } from '../../services/searchTiming';
import { mediaOffsetLabel } from '../../services/mediaSeek';

const EMPTY = [];
const busyStages = ['model', 'index', 'query'];
const control = 'min-h-11 rounded px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700';

function SearchProgress({ status, count, onCancel }) {
  const [now, setNow] = useState(performance.now());
  const busy = busyStages.includes(status.stage);
  useEffect(() => {
    if (!busy) return undefined;
    setNow(performance.now());
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  if (!busy) return null;
  const elapsed = Math.max(0, now - status.started);
  const estimate = estimateSearchRemaining(status.stage, count, status.completed || 0, Math.max(0, now - status.stageStarted));
  const stage = { model: 'Preparing the search model', index: 'Indexing the conversation', query: 'Finding related passages' }[status.stage];
  return <div className="my-3 rounded bg-slate-50 p-3 text-xs text-slate-700">
    <p role="status" aria-live="polite">{stage}{status.stage === 'index' ? ` · ${status.completed} of ${status.total} passages` : ''}</p>
    <p className="mt-1 tabular-nums" aria-hidden="true">{Math.floor(elapsed / 1000)}s elapsed · {estimate ? `Estimated ${estimate.low}–${estimate.high}s remaining` : 'Time remaining unknown'}</p>
    <button type="button" className={`${control} mt-1 px-0 underline underline-offset-4`} onClick={onCancel}>Cancel preparation</button>
  </div>;
}
SearchProgress.propTypes = { status: PropTypes.object.isRequired, count: PropTypes.number.isRequired, onCancel: PropTypes.func.isRequired };

export default function ViewerFindMenu({ groups, onSelect, documents = EMPTY, onResult }) {
  const menu = useRef(null);
  const input = useRef(null);
  const [query, setQuery] = useState('');
  const [meaningQuery, setMeaningQuery] = useState('');
  const semantic = useConversationSearch(documents);
  const busy = busyStages.includes(semantic.status.stage);
  const textResults = searchConversationText(documents, query);
  const meaningReady = semantic.status.stage === 'ready' && meaningQuery === query;
  const results = meaningReady ? semantic.results : textResults;
  const close = () => { menu.current.open = false; semantic.cancel(); };
  const choose = item => {
    if (onResult) onResult(item);
    else if (item.nodeId) onSelect(item.nodeId);
    close();
  };
  return <details ref={menu} className="relative shrink-0 text-sm" onToggle={() => {
    if (menu.current?.open) input.current?.focus();
    else semantic.cancel();
  }}>
    <summary className={`${control} flex cursor-pointer list-none items-center gap-2 text-slate-700 hover:bg-slate-100`}><Search aria-hidden="true" className="h-4 w-4" />Find</summary>
    <div className="fixed left-3 top-3 z-[70] max-h-[calc(100dvh-1.5rem)] w-[min(30rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl bg-white p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label htmlFor="conversation-search" className="font-medium text-slate-800">Search the conversation</label>
        <button type="button" onClick={close} aria-label="Close Find" className={`${control} flex items-center gap-1 text-slate-600`}><X aria-hidden="true" className="h-4 w-4" />Close</button>
      </div>
      <form onSubmit={event => { event.preventDefault(); setMeaningQuery(query); semantic.search(query); }}>
        <input ref={input} id="conversation-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Search ideas and exact words…" className="min-h-11 w-full rounded border border-slate-300 px-3 text-sm text-slate-800 outline-none focus:border-amber-700" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs leading-5 text-slate-600">Text matches appear immediately.</p>
          <button type="submit" disabled={query.trim().length < 2 || busy || !documents.length} className={`${control} shrink-0 bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50`}>{semantic.status.stage === 'error' ? 'Retry meaning search' : 'Search by meaning'}</button>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">Meaning search stays on this device. The first use downloads a search model.</p>
      </form>
      <SearchProgress status={semantic.status} count={documents.length} onCancel={semantic.cancel} />
      {semantic.status.stage === 'error' && <p role="alert" className="my-3 text-xs leading-5 text-amber-800">{semantic.status.message} You can keep using text search.</p>}
      {semantic.status.stage === 'cancelled' && <p role="status" className="my-2 text-xs text-slate-600">Preparation cancelled. Text search is available.</p>}
      {query.trim() && <div className="mt-4">
        <p className="mb-2 text-xs text-slate-600" role="status">{meaningReady ? 'Related passages' : 'Text matches'} · {results.length}{results.length === 12 ? '+' : ''}</p>
        <ul className="divide-y divide-slate-100">{results.map(item => <li key={item.id}>
          <button type="button" onClick={() => choose(item)} className={`${control} w-full px-2 py-3 text-left hover:bg-slate-50`}>
            <span className="block font-medium text-slate-800">{item.kind === 'node' ? 'Branch · ' : `${mediaOffsetLabel(item.seconds) || 'Source passage'} · `}{item.title}</span>
            <span className="mt-1 line-clamp-3 text-xs leading-5 text-slate-600">{item.text}</span>
          </button>
        </li>)}</ul>
        {!results.length && <p className="py-2 text-sm text-slate-600">No text matches. Try another phrase or search by meaning.</p>}
      </div>}
      {groups.map(group => <details key={group.id} className="mt-3 border-t border-slate-100 pt-1">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-slate-800">{group.label} · {group.nodes.length}</summary>
        <p className="mb-2 text-xs leading-5 text-slate-600">{group.description}</p>
        <ul>{group.nodes.map(node => <li key={node.id}><button type="button" onClick={() => { onSelect(String(node.id)); close(); }}
          className={`${control} w-full px-2 py-2 text-left leading-5 text-slate-700 hover:bg-slate-50`}>{node.node_name || node.title || 'Untitled branch'}</button></li>)}</ul>
      </details>)}
    </div>
  </details>;
}

ViewerFindMenu.propTypes = {
  groups: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, label: PropTypes.string, description: PropTypes.string, nodes: PropTypes.array })).isRequired,
  onSelect: PropTypes.func.isRequired,
  documents: PropTypes.array,
  onResult: PropTypes.func,
};
