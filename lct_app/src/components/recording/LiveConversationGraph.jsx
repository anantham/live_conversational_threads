import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import MinimalGraph from '../MinimalGraph.jsx';
import { flattenThreadsGraph } from '../../services/threadsArtifact.js';
import { indexExplicitEdges } from '../../services/edgeContract.js';
import { enrichGraphNodesWithProvenance } from '../graphProvenance.js';
import { withThreadLanes } from '../threads/threadPresentation.js';

export default function LiveConversationGraph({ bundle, transcriptVisible, onConfigure, recording }) {
  const [selected, setSelected] = useState(null), [focus, setFocus] = useState(null), [focusKey, setFocusKey] = useState(0);
  const nodes = useMemo(() => bundle ? withThreadLanes(enrichGraphNodesWithProvenance(indexExplicitEdges(flattenThreadsGraph(bundle.graph_data), bundle.edges, true), bundle.utterances || []), bundle.conversation_threads || []) : [], [bundle]);
  const chosen = nodes.find(n => n.id === selected);
  function select(id) { setSelected(id); setFocus(id); setFocusKey(k => k + 1); }
  return <div className="relative isolate flex min-h-0 flex-1 flex-col" aria-label="Live conversation graph">
    {bundle ? <>
      {!!bundle.conversation_threads?.length && <div className="relative z-50 h-11 shrink-0 border-b border-slate-100 bg-white px-3"><details className="absolute top-0 max-h-64 w-56 max-w-[90%] overflow-auto rounded-lg border border-slate-200 bg-white text-xs shadow-sm">
        <summary className="min-h-11 cursor-pointer px-3 py-3 font-medium">Threads · {bundle.conversation_threads.length}</summary>
        <div className="px-3 pb-3">{bundle.conversation_threads.map(thread => <details key={thread.id} className="border-t border-slate-100">
          <summary className="min-h-11 cursor-pointer py-3">{thread.title}</summary>
          {thread.steps.map((step, i) => <button key={`${step.moment_id}-${i}`} className="block min-h-11 w-full py-2 text-left text-slate-600 hover:text-slate-900" onClick={() => select(step.moment_id)}>{nodes.find(n => n.id === step.moment_id)?.node_name || 'Source moment'}</button>)}
        </details>)}</div>
      </details></div>}
      <div className="relative min-h-0 flex-1">
      <MinimalGraph graphData={nodes} semanticEdges={bundle.edges} selectedNode={selected} setSelectedNode={setSelected}
        focusNode={focus} focusRequestKey={focusKey} viewportReservationKey={String(transcriptVisible)} diagnosticsEnabled={false} hideWeaknessLenses />
      </div>
      {chosen && <aside aria-label="Selected idea" className="absolute bottom-3 right-3 z-20 max-h-[55%] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <div className="flex items-start justify-between gap-3"><h2 className="font-semibold">{chosen.node_name}</h2><button className="min-h-11 shrink-0 px-2 text-xs" onClick={() => setSelected(null)}>Close idea</button></div>
        {chosen.summary && <p className="mt-2 text-slate-600">{chosen.summary}</p>}
        <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3">Source words</summary>{(chosen.source_ref?.utterance_ids || []).map(id => <blockquote className="mb-3 whitespace-pre-wrap text-xs leading-6" key={id}>{bundle.utterances.find(u => u.id === id)?.text}</blockquote>)}</details>
      </aside>}
    </> : <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-slate-700">{recording ? 'Your threads will take shape here' : 'A conversation, with room for tangents'}</p>
      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">{recording ? 'Open AI map to turn your words into connected ideas while you speak.' : 'Record without signing in. Start recording below. Follow the transcript and explore the threads as they develop.'}</p>
      {recording && <button className="mt-3 min-h-11 px-3 text-xs underline underline-offset-4" onClick={onConfigure}>Set up live map</button>}
    </div>}
  </div>;
}
LiveConversationGraph.propTypes = { bundle: PropTypes.object, transcriptVisible: PropTypes.bool, onConfigure: PropTypes.func.isRequired, recording: PropTypes.bool };
