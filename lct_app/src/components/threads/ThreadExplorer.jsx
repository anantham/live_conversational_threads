import { useRef, useState } from "react";
import PropTypes from "prop-types";
import YouTubeSourcePanel from "./YouTubeSourcePanel";
import { mediaOffsetLabel } from "../../services/mediaSeek";

// Thread membership is independent of summary hierarchy. This experiment makes
// the interpretation inspectable rather than hiding it in a categorical color.
export default function ThreadExplorer({ bundle, nodes, onClose }) {
  const threads = bundle.conversation_threads || [];
  const scrollHost = useRef(null);
  const [threadId, setThreadId] = useState(threads[0]?.id);
  const [momentId, setMomentId] = useState(null);
  const thread = threads.find((t) => t.id === threadId) || threads[0];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moment = byId.get(momentId);
  const choose = (id) => { setThreadId(id); setMomentId(null); scrollHost.current?.scrollTo({top:0}); };
  return <main ref={scrollHost} className="h-[100dvh] overflow-y-auto bg-[#faf9f6] p-4 text-slate-800 sm:p-8">
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Threads · {threads.length}</h1>
        <button className="rounded border px-3 py-2" onClick={onClose}>Cards / map</button>
      </header>
      <p className="mb-4 text-sm text-slate-600">Interpretations to inspect, not settled categories. A moment can belong to more than one thread.</p>
      <label className="mb-5 block text-sm sm:hidden">Choose a thread
        <select aria-label="Choose a thread" value={thread?.id || ""} onChange={e=>choose(e.target.value)} className="mt-2 w-full rounded-lg border bg-white p-3">
          {threads.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
      </label>
      <nav aria-label="Conversation threads" className="mb-6 hidden flex-wrap gap-2 sm:flex">
        {threads.map((t) => <button key={t.id} aria-pressed={t.id === thread?.id}
          className={`rounded-xl border px-3 py-2 text-left text-sm ${t.id === thread?.id ? "border-amber-600 bg-amber-50" : "bg-white"}`}
          onClick={() => choose(t.id)}>{t.title}</button>)}
      </nav>
      {thread && <section aria-label="Selected thread">
        <h2 className="mb-2 text-2xl font-semibold">{thread.title}</h2>
        <p className="mb-3 leading-relaxed">{thread.summary}</p>
        <p className="mb-5 text-sm text-slate-600">{thread.status}: {thread.status_reason}</p>
        {moment && <div className="mb-4 rounded-xl border bg-white">
          <button className="px-3 py-2 text-sm" onClick={() => setMomentId(null)}>Close source</button>
          <YouTubeSourcePanel bundle={bundle} node={moment} nodes={nodes} compact />
        </div>}
        <ol className="space-y-4">
          {thread.steps.map((step, index) => {
            const node = byId.get(step.moment_id);
            if (!node) return null;
            const shared = threads.filter((t) => t.id !== thread.id && t.steps.some((s) => s.moment_id === node.id));
            const returns = (thread.returns || []).filter((r) => r.from === node.id);
            return <li key={node.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <button className="text-left font-semibold text-amber-800" onClick={() => { setMomentId(node.id); scrollHost.current?.scrollTo({top:0}); }}>
                {index + 1}. {node.node_name} <span className="text-xs font-normal">{mediaOffsetLabel(node.timestamp_start)}</span>
              </button>
              <p className="mt-2 text-sm leading-relaxed">{step.why}</p>
              <details className="mt-2 text-sm"><summary className="cursor-pointer text-slate-600">Evidence · {step.evidence_utterance_ids.length} segments</summary>
                {step.evidence_utterance_ids.map((id) => {
                  const u = bundle.utterances.find((row) => row.id === id);
                  return u ? <p key={id} className="mt-2 border-l-2 border-amber-200 pl-3">{u.speaker_name || u.speaker_id}: {u.text}</p> : null;
                })}
              </details>
              {returns.map((r) => <p key={`${r.from}-${r.to}`} className="mt-3 text-sm text-slate-600">
                <strong>{r.kind === "explicit_callback" ? "Explicit return" : "Interpretive connection"}</strong> to <button className="text-amber-800" onClick={()=>{setMomentId(r.to);scrollHost.current?.scrollTo({top:0});}}>{byId.get(r.to)?.node_name}</button>: {r.why}
              </p>)}
              {shared.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">Also in
                {shared.map((t) => <button key={t.id} className="rounded border px-2 py-1 text-amber-800" onClick={() => choose(t.id)}>{t.title}</button>)}
              </div>}
            </li>;
          })}
        </ol>
      </section>}
    </div>
  </main>;
}
ThreadExplorer.propTypes = { bundle: PropTypes.object.isRequired, nodes: PropTypes.array.isRequired, onClose: PropTypes.func.isRequired };
