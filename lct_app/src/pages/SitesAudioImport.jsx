import { useEffect, useMemo, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { useAudioImport } from '../hooks/useAudioImport.js';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import ConversationNavigation, { CloseConversationTools } from '../components/recording/ConversationNavigation.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import RecordingAudioFiles from '../components/recording/RecordingAudioFiles.jsx';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { ConversationStorageSettings, ConversationStorageStatus } from '../components/recording/ConversationStorage.jsx';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50';
const noPrivateSave = () => {};

export default function SitesAudioImport() {
  const flow = useAudioImport();
  const [panel, setPanel] = useState(null), [minimized, setMinimized] = useState(false), [fullscreen, setFullscreen] = useState(false), [generating, setGenerating] = useState(false);
  const { archive, recording, audio, transcript, map, activity, busy, capability } = flow;
  const artifact = useMemo(() => {
    if (!recording || !transcript.finalTokens.length) return null;
    const source = { recordingId: recording.id, startedAt: recording.startedAt, finalTokens: transcript.finalTokens,
      complete: ['stopped', 'mapping', 'complete'].includes(activity?.stage) };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript file could not be prepared. Your audio and words are preserved.' }; }
  }, [recording, transcript, activity?.stage]);
  useEffect(() => {
    if ((!recording || archive.status.state === 'saved') && !busy && !generating) return;
    const protect = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [recording, archive.status.state, busy, generating]);
  function guardNavigation(event) {
    if ((!busy && !generating && archive.status.state === 'saved') || !recording) return;
    const link = event.target.closest?.('a[href]');
    if (link && !link.hasAttribute('download') && !window.confirm('Leave this import? Processing will stop. Download unsaved files before leaving.')) event.preventDefault();
  }
  return <main onClickCapture={guardNavigation} className="grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] text-slate-800">
    <ConversationNavigation title="Import audio" panel={panel} onPanelChange={setPanel} />
    <section aria-label="Audio import canvas" className="relative flex min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 py-2 text-xs leading-5">
        {activity && <p role="status">{activity.message}{busy && ' · ' + flow.elapsed + ' s elapsed'}</p>}
        {archive.status.state === 'error' && <ConversationStorageStatus status={archive.status} preference={recording?.retention || archive.preference} onRetry={archive.retry} />}
        {flow.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">{flow.error}</p>}
      </div>
      {!recording && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <form className="mx-auto max-w-xl space-y-5" onSubmit={event => { event.preventDefault(); void flow.start(); }}>
          <h2 className="text-xl font-semibold">Import audio</h2>
          <p className="text-sm leading-6 text-slate-600">Turn an MP3, WAV or M4A file into a transcript and connected threads.</p>
          <label className="block text-sm font-medium" htmlFor="audio-import-file">Audio file</label>
          <input id="audio-import-file" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" className="block w-full min-w-0 text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3" disabled={busy} onChange={event => { flow.setFile(event.target.files?.[0] || null); flow.setConsent(false); }} />
          <p className="text-xs text-slate-500">Up to 20 MiB and {capability ? Math.floor(capability.max_session_seconds / 60) + ' minutes' : 'the configured session limit'}. Keep this tab open while processing.</p>
          <label className="block text-sm" htmlFor="import-provider">AI provider for threads</label>
          <select id="import-provider" value={flow.backend} disabled={busy} onChange={event => { flow.setBackend(event.target.value); flow.setConsent(false); }} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3">
            <option value="openrouter">OpenRouter</option><option value="gemini">Gemini · Google AI Studio</option>
          </select>
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1" checked={flow.consent} onChange={event => flow.setConsent(event.target.checked)} />I have permission to send this audio to Soniox for transcription and its transcript to {flow.backend === 'gemini' ? 'Google Gemini through Google AI Studio' : 'OpenRouter and the selected model provider'} to create threads.</label>
          <p className="text-xs leading-5 text-slate-500">{archive.preference === 'local' ? 'Audio, transcript and threads save in this browser. Nothing is published automatically.' : 'Ephemeral mode: download your files before closing this tab.'}</p>
          <button type="submit" className={button + ' bg-slate-900 text-white'} disabled={!flow.file || !flow.consent || flow.loading || !capability?.enabled || busy}><Upload size={17} aria-hidden="true" />Create transcript &amp; threads</button>
          {!flow.loading && !capability?.enabled && <p className="text-sm text-slate-600">Transcription is currently unavailable. Your file has not been sent.</p>}
          {flow.loading && <p role="status" className="text-sm">Checking transcription setup…</p>}
          {!capability && !flow.loading && <button type="button" className={button} onClick={() => void flow.check()}>Check setup again</button>}
        </form>
      </div>}
      {recording && <>
        {map ? <LiveConversationGraph bundle={map} transcriptVisible={!minimized} onConfigure={() => setPanel('map')} recording /> :
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" aria-label="Imported conversation graph">
            <p className="text-sm font-medium text-slate-700">{busy ? 'Your threads will take shape here' : 'No thread map is saved'}</p>
            <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">{busy ? 'Threads are created after transcription finishes.' : 'Open AI map to check generation availability.'} {(audio || artifact) && 'Your available audio and transcript are in Files & export.'}</p>
          </div>}
        <ConversationTranscriptPanel transcript={transcript} status={busy ? 'Importing' : artifact?.source?.complete ? 'Finished' : 'Partial'} minimized={minimized} onMinimize={() => { setMinimized(value => !value); setFullscreen(false); }} fullscreen={fullscreen} onFullscreen={() => setFullscreen(value => !value)} />
      </>}
      <aside hidden={!panel} aria-label="Import tools" className="absolute right-3 top-3 z-40 max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <CloseConversationTools onClose={() => setPanel(null)} />
        <div hidden={panel !== 'settings'}><h2 className="pt-12 text-lg font-medium">Settings</h2><fieldset disabled={busy || generating}><ConversationStorageSettings preference={archive.preference} onChange={archive.choose} error={archive.preferenceError} /></fieldset><ConversationStorageStatus status={archive.status} preference={recording?.retention || archive.preference} onRetry={archive.retry} /></div>
        <div hidden={panel !== 'map'}>
          {!artifact?.source && <p className="pt-12 text-sm text-slate-600">Threads appear after your transcript is ready.</p>}
          {artifact?.source && <RecordingConversationMap localOnly source={artifact.source} savedBundle={map} retention={recording.retention} backend={flow.backend} onBackendChange={flow.setBackend} privateEnabled={false} saving={busy} onGeneratingChange={setGenerating} onMapChange={flow.mapReady} onPrivateSave={noPrivateSave} />}
        </div>
        <div hidden={panel !== 'files'}>
          <RecordingAudioFiles localOnly retention={recording?.retention} audio={audio} recordingId={recording?.id} privateEnabled={false} busy={busy || generating} onPrivateSave={noPrivateSave} />
          <RecordingTranscriptFiles localOnly retention={recording?.retention} artifact={artifact} privateEnabled={false} saving={busy || generating} onPrivateSave={noPrivateSave} />
          {map && <button type="button" className={button + ' mt-4'} onClick={() => setPanel('map')}>Download your map</button>}
        </div>
      </aside>
    </section>
    <footer className="flex min-h-16 flex-wrap items-center justify-center gap-3 border-t border-slate-100 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {busy ? <button className={button} onClick={flow.cancel}><X size={17} aria-hidden="true" />Stop processing</button> : recording && <><button className={button} onClick={() => setPanel('files')}>Files &amp; export</button><a href="/import-audio" className={button}>Import another file</a></>}
      {!recording && <button className="min-h-11 px-3 text-xs underline" onClick={() => setPanel('settings')}>Saving preferences</button>}
    </footer>
  </main>;
}
