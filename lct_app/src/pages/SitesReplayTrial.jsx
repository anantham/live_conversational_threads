import { useEffect, useMemo, useState } from 'react';
import { useReplayDiagnostics } from '../hooks/useReplayDiagnostics.js';
import { useReplayTrial } from '../hooks/useReplayTrial.js';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import ConversationNavigation, { CloseConversationTools } from '../components/recording/ConversationNavigation.jsx';
import RecordingAudioFiles from '../components/recording/RecordingAudioFiles.jsx';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
export default function SitesReplayTrial() {
  const flow = useReplayTrial(), [panel, setPanel] = useState(null), [minimized, setMinimized] = useState(false), [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!flow.busy && flow.archive.status.state === 'saved') return;
    if (!flow.recording) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [flow.busy, flow.archive.status.state, flow.recording]);
  const diagnostics = useReplayDiagnostics(flow.busy);
  const artifact = useMemo(() => {
    if (!flow.recording || !flow.transcript.finalTokens.length) return null;
    try { return createRecordingTranscript({ recordingId: flow.recording.id, startedAt: flow.recording.startedAt, finalTokens: flow.transcript.finalTokens, complete: flow.transcriptionComplete }); } catch { return null; }
  }, [flow.recording, flow.transcript, flow.transcriptionComplete]);
  return <main className="grid h-[100dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] text-slate-800">
    <ConversationNavigation title="Private replay test" panel={panel} onPanelChange={setPanel} />
    <section className="relative flex min-h-0 flex-col" aria-label="Replay canvas">
      <div className="shrink-0 px-5 py-2 text-xs"><p role="status">{flow.stage} · {flow.elapsed}s · {flow.metrics.length} map updates · {flow.archive.status.state}</p>{flow.error && <p role="alert" className="my-2 rounded-lg bg-rose-50 p-3 text-rose-900">{flow.error}</p>}</div>
      {!flow.recording ? <form className="mx-auto w-full max-w-xl space-y-4 overflow-y-auto px-5 py-5 text-sm" onSubmit={event => { event.preventDefault(); void flow.start(); }}>
        <h2 className="text-xl font-semibold">20-minute private replay</h2><p>One audio stream and up to 28 map updates. Same providers; no automatic retry. Audio and results save in this browser.</p>
        <label className="block" htmlFor="replay-file">Prepared 20-minute audio</label><input id="replay-file" type="file" accept=".m4a,.mp3,.wav" onChange={event => { flow.setFile(event.target.files?.[0] || null); flow.setConsent(false); }} />
        <label className="flex gap-3"><input type="checkbox" checked={flow.consent} onChange={event => flow.setConsent(event.target.checked)} />I have permission to send this recording to Soniox and its transcript to OpenRouter and the selected model provider for this private test.</label>
        {flow.setup?.budget && <p id="replay-budget">Existing allowance: ${flow.setup.budget.available_usd.toFixed(2)} · conservative test bound: ${flow.setup.budget.required_usd.toFixed(2)} · {flow.setup.budget.sufficient ? 'sufficient' : 'insufficient; no paid operation started'}</p>}
        <button type="submit" className="min-h-11 rounded-lg bg-slate-900 px-4 text-white disabled:opacity-50" disabled={!flow.consent || !flow.file || !flow.setup?.enabled || !flow.setup?.budget.sufficient}>Start approved replay</button>
        <button type="button" className="min-h-11 px-3 underline" onClick={() => void flow.check()}>Check replay readiness</button>
      </form> : <><LiveConversationGraph bundle={flow.map} transcriptVisible={!minimized} onConfigure={() => setPanel('files')} recording />
        <ConversationTranscriptPanel transcript={flow.transcript} status={flow.stage} minimized={minimized} onMinimize={() => setMinimized(x => !x)} fullscreen={fullscreen} onFullscreen={() => setFullscreen(x => !x)} /></>}
      <aside hidden={!panel} aria-label="Replay tools" className="absolute right-3 top-3 z-50 max-h-[90%] w-[28rem] max-w-[95%] overflow-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg"><CloseConversationTools onClose={() => setPanel(null)} />
        <RecordingAudioFiles localOnly retention="local" audio={flow.audio} recordingId={flow.recording?.id} privateEnabled={false} busy={flow.busy} onPrivateSave={() => {}} />
        <RecordingTranscriptFiles localOnly retention="local" artifact={artifact} privateEnabled={false} saving={flow.busy} onPrivateSave={() => {}} />
        {flow.map && <details><summary>Inspect source-linked map</summary><textarea id="replay-map-json" readOnly value={JSON.stringify(flow.map)} className="w-full" rows={5} /></details>}
      </aside>
    </section><footer className="flex min-h-16 flex-wrap items-center justify-center gap-3 border-t border-slate-100 px-4 py-2">
      {flow.busy && <button className="min-h-11 rounded-lg border px-4" onClick={flow.stop}>Stop replay</button>}{flow.recording && <button className="min-h-11 px-4 underline" onClick={() => setPanel('files')}>Files & export</button>}
      <details className="max-w-full text-xs"><summary>Test measurements</summary><pre id="replay-metrics" className="max-h-40 overflow-auto">{JSON.stringify({ stage: flow.stage, elapsed: flow.elapsed, tokens: flow.transcript.finalTokens.length, updates: flow.metrics, diagnostics }, null, 2)}</pre></details>
    </footer>
  </main>;
}
