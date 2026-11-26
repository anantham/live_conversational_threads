import { useEffect, useMemo, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { MAP_TESTED_SECONDS, useYouTubeImport } from '../hooks/useYouTubeImport.js';
import { useImportPrivateFiles } from '../hooks/useImportPrivateFiles.js';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import { formatDuration } from '../services/youtubeImport.js';
import ConversationNavigation, { CloseConversationTools } from '../components/recording/ConversationNavigation.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import ImportPrivateFiles from '../components/recording/ImportPrivateFiles.jsx';
import PublicTaskStatus from '../components/PublicTaskStatus.jsx';
import { ConversationStorageSettings, ConversationStorageStatus } from '../components/recording/ConversationStorage.jsx';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50';

export default function SitesYouTubeImport() {
  const flow = useYouTubeImport();
  const [panel, setPanel] = useState(null), [minimized, setMinimized] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [generating, setGenerating] = useState(false), [mapError, setMapError] = useState('');
  const { archive, recording, transcript, map, activity, busy } = flow;
  const privateFiles = useImportPrivateFiles(busy || generating);
  const artifact = useMemo(() => {
    if (!recording || !transcript.finalTokens.length) return null;
    const source = { recordingId: recording.id, startedAt: recording.startedAt, finalTokens: transcript.finalTokens, complete: true };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript file could not be prepared within its size or data limits. Your imported words are still shown here.' }; }
  }, [recording, transcript]);
  const youtube = recording?.youtube;
  const lastEnd = transcript.finalTokens.at(-1)?.endMs ?? 0;
  const longVideo = Math.max(youtube?.length_seconds ?? 0, lastEnd / 1000) > MAP_TESTED_SECONDS;
  useEffect(() => {
    if ((!recording || archive.status.state === 'saved') && !busy && !generating && !privateFiles.saving) return;
    const protect = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [recording, archive.status.state, busy, generating, privateFiles.saving]);
  function guardNavigation(event) {
    if ((!busy && !generating && !privateFiles.saving && archive.status.state === 'saved') || !recording) return;
    const link = event.target.closest?.('a[href]');
    if (link && !link.hasAttribute('download') && !window.confirm('Leave this import? Download unsaved files before leaving.')) event.preventDefault();
  }
  const list = flow.resolved?.kind === 'playlist' ? flow.resolved : null;
  return <main onClickCapture={guardNavigation} className="grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] text-slate-800">
    <ConversationNavigation title="Import from YouTube" panel={panel} onPanelChange={setPanel} mapUpdating={generating} mapError={mapError} />
    <section aria-label="YouTube import canvas" className="relative flex min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 py-2 text-xs leading-5">
        {activity && <p role="status">{activity.message}</p>}
        {archive.status.state === 'error' && <ConversationStorageStatus status={archive.status} preference={recording?.retention || archive.preference} onRetry={archive.retry} />}
        {flow.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">{flow.error}</p>}
        {privateFiles.message && <p role="status">{privateFiles.message}</p>}
        {privateFiles.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">{privateFiles.error}</p>}
        <PublicTaskStatus activity={privateFiles.saving ? 'load' : null} elapsed={privateFiles.elapsed} cancel={privateFiles.cancel} loadingLabel={`Saving ${privateFiles.subject.toLowerCase()} privately`} />
      </div>
      {!recording && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-xl space-y-5">
          <form className="space-y-5" onSubmit={event => { event.preventDefault(); void flow.find(); }}>
            <h2 className="text-xl font-semibold">Import from YouTube</h2>
            <p className="text-sm leading-6 text-slate-600">Paste a video or playlist link. The Site reads the video&apos;s captions and turns them into a transcript you can map into threads.</p>
            <label className="block text-sm font-medium" htmlFor="youtube-link">YouTube link</label>
            <input id="youtube-link" type="text" inputMode="url" autoComplete="off" spellCheck="false" placeholder="https://www.youtube.com/watch?v=… or a playlist link" value={flow.link} disabled={flow.busy || flow.resolving}
              onChange={event => flow.setLink(event.target.value)} className="block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" />
            <p className="text-xs leading-5 text-slate-500">Only the link is sent to YouTube. Nothing goes to an AI provider until you ask for threads. Private videos, videos without captions and live streams cannot be imported.</p>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className={button + ' bg-slate-900 text-white'} disabled={!flow.link.trim() || flow.busy || flow.resolving}><Link2 size={17} aria-hidden="true" />Find transcript</button>
              {(flow.resolving || flow.busy) && <button type="button" className={button} onClick={flow.cancel}><X size={17} aria-hidden="true" />Cancel</button>}
            </div>
            {flow.resolving && <p role="status" className="text-sm">Looking up your link…</p>}
            {flow.busy && <p role="status" className="text-sm">Reading captions from YouTube…</p>}
          </form>
          {list && <section aria-label="Playlist videos" className="space-y-3">
            <h3 className="text-base font-medium">{list.title || 'Playlist'} · {list.videos.length} video{list.videos.length === 1 ? '' : 's'}</h3>
            <p className="text-xs leading-5 text-slate-500">Choose a video to import. Each video becomes its own conversation, one at a time.{list.truncated && ' Only the first videos of a long playlist are listed.'}</p>
            <ul className="space-y-2">{list.videos.map(video => <li key={video.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{video.title || video.id}</span>
                <span className="block text-xs text-slate-500">{video.duration_seconds ? formatDuration(video.duration_seconds) : 'Length unknown'}{video.id === list.selected_video_id && ' · the video you linked'}</span></span>
              <button type="button" className={button} disabled={flow.busy} onClick={() => void flow.importVideo(video)}>{flow.loadingId === video.id ? 'Importing…' : 'Import transcript'}</button>
            </li>)}</ul>
          </section>}
        </div>
      </div>}
      {recording && <>
        {map ? <LiveConversationGraph bundle={map} transcriptVisible={!minimized} onConfigure={() => setPanel('map')} recording /> :
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" aria-label="Imported conversation graph">
            <p className="text-sm font-medium text-slate-700">{youtube?.title || 'Imported transcript'}</p>
            <button className="mt-3 min-h-11 px-3 text-xs underline" onClick={() => setPanel('map')}>Open AI map to create threads</button>
            <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">Your transcript is ready and nothing has been sent to an AI provider. It is also in Files &amp; export.</p>
            {longVideo && <p role="note" className="mt-2 max-w-sm text-xs leading-5 text-amber-900">This video is longer than about 20 minutes. Threads have only been tested up to that length, so a map may fail or come out coarse. The transcript is complete either way.</p>}
          </div>}
        <ConversationTranscriptPanel transcript={transcript} status="Imported" minimized={minimized} onMinimize={() => { setMinimized(value => !value); setFullscreen(false); }} fullscreen={fullscreen} onFullscreen={() => setFullscreen(value => !value)} />
      </>}
      <aside hidden={!panel} aria-label="Import tools" className="absolute right-3 top-3 z-40 max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <CloseConversationTools onClose={() => setPanel(null)} />
        {recording && ['map', 'files'].includes(panel) && <ImportPrivateFiles status={privateFiles.status} saving={privateFiles.saving} onCheck={() => void privateFiles.check()} />}
        <div hidden={panel !== 'settings'}><h2 className="pt-12 text-lg font-medium">Settings</h2><fieldset disabled={busy || generating}><ConversationStorageSettings preference={archive.preference} onChange={archive.choose} error={archive.preferenceError} /></fieldset><ConversationStorageStatus status={archive.status} preference={recording?.retention || archive.preference} onRetry={archive.retry} /></div>
        <div hidden={panel !== 'map'}>
          {!artifact?.source && <p className="pt-12 text-sm text-slate-600">Threads appear after a transcript is imported.</p>}
          {artifact?.source && <RecordingConversationMap localOnly={!privateFiles.ready} source={artifact.source} savedBundle={map} retention={recording.retention} backend={flow.backend} onBackendChange={flow.setBackend} privateEnabled={privateFiles.ready} saving={privateFiles.saving} recordingBusy={false} onGeneratingChange={setGenerating} onMapStatusChange={setMapError} onMapChange={flow.mapReady} onPrivateSave={privateFiles.save} />}
        </div>
        <div hidden={panel !== 'files'}>
          <RecordingTranscriptFiles localOnly={!privateFiles.ready} retention={recording?.retention} artifact={artifact} privateEnabled={privateFiles.ready} saving={busy || generating || privateFiles.saving} onPrivateSave={privateFiles.save} />
          {map && <button type="button" className={button + ' mt-4'} onClick={() => setPanel('map')}>Download your map</button>}
        </div>
      </aside>
    </section>
    <footer className="flex min-h-16 flex-wrap items-center justify-center gap-3 border-t border-slate-100 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {recording ? <><button className={button} onClick={() => setPanel('files')}>Files &amp; export</button>
        <a href="/import-youtube" className={button}>Import another video</a></>
        : <button className="min-h-11 px-3 text-xs underline" onClick={() => setPanel('settings')}>Saving preferences</button>}
    </footer>
  </main>;
}
