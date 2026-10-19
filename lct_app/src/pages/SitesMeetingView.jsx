import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { useSiteMeeting } from '../hooks/useSiteMeeting.js';
import { useMeetingArchive } from '../hooks/useMeetingArchive.js';
import { meetingPath, meetingRequest, meetingStateText, meetingIO } from '../services/cloud/sitesMeetings.js';
import { checkSiteSession } from '../services/cloud/siteSession.js';
import { privateRequest } from '../services/privateFiles.js';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import ConversationNavigation, { CloseConversationTools } from '../components/recording/ConversationNavigation.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import { ConversationStorageStatus } from '../components/recording/ConversationStorage.jsx';

const empty = { finalText: '', finalTokens: [], partialText: '', partialTokens: [] };
const button = 'min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50';
export default function SitesMeetingView({ id }) {
  const { data, error, refresh } = useSiteMeeting(id);
  const local = useMeetingArchive(id, data);
  const [panel, setPanel] = useState(null), [minimized, setMinimized] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [backend, setBackend] = useState('openrouter'), [generating, setGenerating] = useState(false);
  const [leaving, setLeaving] = useState(false), [leaveMessage, setLeaveMessage] = useState('');
  const [privateEnabled, setPrivateEnabled] = useState(false), [saving, setSaving] = useState(false), [saveMessage, setSaveMessage] = useState('');
  const uploads = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([meetingIO(signal => privateRequest('/api/cloud/files/status', { signal }), controller.signal), checkSiteSession(controller.signal)]).then(([status, session]) => { if (!controller.signal.aborted) setPrivateEnabled(session === 'signed-in' && Boolean(status.enabled && status.configured && !status.synthetic_only)); }).catch(() => {});
    return () => { controller.abort(); uploads.current?.abort(); };
  }, []);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const transcript = data?.transcript || local.restored?.transcript || empty, snapshot = data?.snapshot;
  const audioClock = snapshot?.start_timestamp_ms || local.restored?.recording.startedAt;
  const recordingComplete = snapshot ? snapshot.recording_state === 'complete' : local.restored?.stage === 'stopped';
  const [localAudioURL, setLocalAudioURL] = useState('');
  useEffect(() => {
    const blob = local.restored?.stage === 'stopped' && local.restored?.audio?.mimeType === 'audio/mpeg' ? local.restored.audio.blob : null;
    if (!blob) return;
    const url = URL.createObjectURL(blob); setLocalAudioURL(url);
    return () => URL.revokeObjectURL(url);
  }, [local.restored?.audio?.blob]);
  const ended = data?.meeting?.state === 'ended';
  const state = snapshot?.state || data?.meeting?.state;
  const artifact = useMemo(() => {
    if (!audioClock || !transcript.finalTokens.length) return null;
    const source = { recordingId: id, startedAt: audioClock, finalTokens: transcript.finalTokens, complete: Boolean(recordingComplete) };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript exceeds map or file limits. You can still copy it from the transcript panel.' }; }
  }, [id, audioClock, recordingComplete, transcript]);
  const mapChanged = useCallback(bundle => local.mapReady(bundle), [local.mapReady]);
  async function savePrivate(file, subject) {
    if (!privateEnabled || uploads.current || generating) return;
    const controller = new AbortController(); uploads.current = controller; setSaving(true); setSaveMessage('');
    try {
      await meetingIO(signal => privateRequest('/api/cloud/files', { method: 'POST', file, signal }), controller.signal, 30_000);
      if (alive.current) setSaveMessage(subject + ' saved to your private cloud files.');
    } catch (failure) { if (alive.current) setSaveMessage('Private save did not complete: ' + failure.message + ' Check Private files before retrying.'); }
    finally { uploads.current = null; if (alive.current) setSaving(false); }
  }
  async function leave() {
    if (leaving || ended) return;
    setLeaving(true); setLeaveMessage('');
    try { const result = await meetingRequest('/' + id + '/leave', { body: {} }); if (alive.current) setLeaveMessage(result.message); }
    catch (failure) { if (alive.current) setLeaveMessage(failure.message || 'Leave could not be confirmed. Check the meeting in Meet.'); }
    finally { if (alive.current) { setLeaving(false); refresh(); } }
  }
  let audioURL = '';
  try { audioURL = localAudioURL || (snapshot?.audio_available ? meetingPath(id) + '/audio' : ''); } catch { /* Invalid route is reported by the polling hook. */ }
  return <main className="grid h-[100dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] text-slate-800">
    <ConversationNavigation panel={panel} onPanelChange={setPanel} />
    <section aria-label="Meeting canvas" className="relative flex min-h-0 flex-col overflow-hidden">
      <div className="px-5 py-2 text-xs leading-5">
        <p role="status">{data ? meetingStateText(state) : 'Connecting to your meeting'}</p>
        {error && <p role="alert" className="text-rose-800">{error} <button className="min-h-8 underline" onClick={refresh}>Reconnect</button> <Link className="underline" to="/meeting">Your meetings</Link></p>}
        {data?.message && <p>{data.message}</p>}
        {saveMessage && <p role="status">{saveMessage}</p>}
        {leaveMessage && <p role="status">{leaveMessage}</p>}
        {(local.error || local.archive.status.state === 'error') && <div className="text-rose-800"><p role="alert">{local.error}</p><ConversationStorageStatus status={local.archive.status} preference={local.retention} onRetry={local.archive.retry} /><button className="min-h-8 underline" onClick={local.retryAudio}>Retry local audio copy</button></div>}
      </div>
      <LiveConversationGraph bundle={local.map} transcriptVisible={!minimized} recording onConfigure={() => setPanel('map')} />
      <ConversationTranscriptPanel transcript={transcript} status={error ? local.restored ? 'Saved on this device · disconnected' : 'Connection interrupted' : ended ? 'Finished' : 'Meet captions'} minimized={minimized} onMinimize={() => { setMinimized(value => !value); setFullscreen(false); }} fullscreen={fullscreen} onFullscreen={() => setFullscreen(value => !value)} />
      <aside hidden={!panel} aria-label="Meeting tools" className="absolute right-3 top-3 z-40 max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <CloseConversationTools onClose={() => setPanel(null)} />
        <div hidden={panel !== 'map'}>
          {!artifact?.source && <p className="pt-12 text-sm">The map becomes available after captions and the recording clock arrive.</p>}
          {artifact?.source && <RecordingConversationMap source={artifact.source} savedBundle={local.map} retention={local.ready ? local.retention : 'ephemeral'} backend={backend} onBackendChange={setBackend} onGeneratingChange={setGenerating} onMapChange={mapChanged} saving={saving} privateEnabled={privateEnabled} onPrivateSave={savePrivate} liveActive={!ended && !error} recordingBusy={!ended} />}
        </div>
        <div hidden={panel !== 'files'} className="pt-12">
          <h2 className="font-medium">Files &amp; export</h2>
          {local.liveAudio.parts > 0 && <section aria-label="Live meeting audio" className="mt-4 text-sm"><p role="status">Live audio · {local.liveAudio.parts} parts received</p><button className="mt-2 min-h-11 underline" onClick={() => void local.liveAudio.toggleMonitoring()}>{local.liveAudio.monitoring ? 'Stop listening' : 'Listen live'}</button><audio className="mt-3 w-full" controls preload="none" src={local.liveAudio.url} aria-label="Latest live audio part" /></section>}
          {local.liveAudio.error && <p role="status" className="mt-3 text-sm text-rose-800">{local.liveAudio.error}</p>}
          {audioURL ? <><audio className="mt-4 w-full" controls preload="none" src={audioURL} aria-label="Meeting recording" /><a className={`${button} mt-3 inline-block`} href={audioURL} download={`meeting-${id}.mp3`}>Download meeting audio</a></> : <p className="mt-3 text-sm text-slate-600">Audio arrives in short parts during the call. The complete MP3 becomes available when the recorder finishes.</p>}
          {!privateEnabled && <Link to="/private-files#site-access" className="mt-3 block min-h-11 text-sm underline">Sign in to save privately in the cloud</Link>}
          <RecordingTranscriptFiles artifact={artifact} retention={local.ready ? local.retention : 'ephemeral'} privateEnabled={privateEnabled} saving={saving || generating} onPrivateSave={savePrivate} />
          {local.map && <button className="mt-3 min-h-11 text-sm underline" onClick={() => setPanel('map')}>Download your map</button>}
        </div>
        <div hidden={panel !== 'settings'} className="pt-12 text-sm leading-6">
          <h2 className="font-medium">Meeting settings</h2>
          <p className="mt-3">The Asus captures Meet captions and audio independently of this tab. Keep it online. Threads update while this view is open and automatic maps are enabled.</p>
          <p className="mt-3">{local.retention === 'local' ? 'Captions, maps and incoming audio save in this browser. The complete MP3 is copied here when the recorder finishes while this view is open.' : 'Ephemeral mode: nothing saves automatically in this browser.'} The recorder also keeps a private working copy on the Asus; it is not added to account history or the public library.</p>
          <p className="mt-3">Recordings currently stop after five minutes at most. Leave recording stops the bot; closing this tab does not.</p>
          <div className="mt-3"><ConversationStorageStatus status={local.archive.status} preference={local.retention} onRetry={local.archive.retry} /></div>
          <Link to="/meeting" className="mt-3 inline-block min-h-11 underline">Your meeting recordings</Link>
        </div>
      </aside>
    </section>
    <footer className="flex items-center justify-center gap-3 border-t border-slate-100 bg-white px-4 py-3">
      {!ended && <button className={button} disabled={leaving || !data || ['leaving', 'post_processing'].includes(state)} onClick={() => void leave()}>{leaving ? 'Requesting leave…' : 'Leave recording'}</button>}
      {ended && <button className={button} onClick={() => setPanel('files')}>Recording files</button>}
      {generating && <span role="status" className="text-xs">Updating threads…</span>}
    </footer>
  </main>;
}
SitesMeetingView.propTypes = { id: PropTypes.string.isRequired };
