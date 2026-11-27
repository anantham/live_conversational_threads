import { useSitesRuntime } from '../contexts/SitesRuntimeContext';
import { requestTranscriptionSession } from '../services/cloud/sonioxSessionClient';
import { MAP_PROVIDERS } from '../services/cloud/openRouterClient.js';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useConversationArchive } from '../hooks/useConversationArchive.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { ConversationStorageSettings, ConversationStorageStatus } from '../components/recording/ConversationStorage.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudConversationSession } from '../services/cloud/cloudConversationSession.js';
import { M5TailnetLiveSession } from '../services/cloud/m5TailnetLiveSession.js';
import { privateRequest } from '../services/privateFiles.js';
import { recordRecordingTiming } from '../services/cloud/recordingTiming.js';
import { readSitesCostEntries, summarizeSitesCosts } from '../services/cloud/sitesCostStore.js';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import RecordingAudioFiles from '../components/recording/RecordingAudioFiles.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import RecordingConsentDialog from '../components/recording/RecordingConsentDialog.jsx';
import ConversationTranscriptionSetting from '../components/recording/ConversationTranscriptionSetting.jsx';
import CloudRecordingToolbar from '../components/recording/CloudRecordingToolbar.jsx';
import ConversationNavigation, { CloseConversationTools } from '../components/recording/ConversationNavigation.jsx';
import ConversationServiceStatus from '../components/recording/ConversationServiceStatus.jsx';
import LiveMapHeartbeat from '../components/recording/LiveMapHeartbeat.jsx';
import { stageGeneratedMap } from '../services/cloud/generatedMapHandoff.js';
import { renameArtifactSpeaker } from '../services/youtubeMedia';
import { buildSpeakerDisplayNames } from '../services/speakerDisplay';
import { Compass } from 'lucide-react';

const ACTIVE = new Set(['microphone', 'authorizing', 'connecting', 'recording', 'finalizing']);
const emptyTranscript = { finalText: '', partialText: '', finalTokens: [], partialTokens: [] };
// How far into the audio the transcript reaches. Token times are audio time, so pauses are not counted.
const heardAudioMs = value => Math.max(0, ...[value.finalTokens.at(-1), value.partialTokens.at(-1)].map(token => token?.endMs ?? token?.startMs).filter(Number.isFinite));
const LEAVE_WARNING = 'Leave this conversation? Download or save your audio, transcript and map first. Unsaved copies will be lost.';
// Names typed on this page label the map's own speaker fields; the source transcript keeps its original ids.
// Stored data is read back as untrusted: plain short strings only.
const savedSpeakerNames = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([id, name]) => id.length <= 128 && typeof name === 'string' && name.trim() && name.length <= 80).slice(0, 64))
  : {};
const withSpeakerNames = (bundle, names) => Object.entries(names).reduce((named, [id, name]) => renameArtifactSpeaker(named, id, name), bundle);

async function abortable(signal, work) {
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work(), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export default function SitesNewConversation() {
  const archive = useConversationArchive(), location = useLocation(), navigate = useNavigate();
  const [restoring, setRestoring] = useState(false);
  const localId = new URLSearchParams(location.search).get('local');
  const [capabilities, setCapabilities] = useState(null), [setup, setSetup] = useState({ startedAt: Date.now() });
  const [activity, setActivity] = useState(null), [elapsed, setElapsed] = useState(0), [pendingRecording, setPendingRecording] = useState(null);
  const [audio, setAudio] = useState(null), [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const [saveStartedAt, setSaveStartedAt] = useState(null);
  const [recording, setRecording] = useState(null), [saveSubject, setSaveSubject] = useState('Audio');
  const [generating, setGenerating] = useState(false);
  const runtime = useSitesRuntime();
  const [chosenBackend, setBackend] = useState('openrouter'), [voiceHealth, setVoiceHealth] = useState(null), [inferenceHealth, setInferenceHealth] = useState(null);
  const [voiceMetrics, setVoiceMetrics] = useState(null), [mapMetrics, setMapMetrics] = useState(null);
  const backend = inferenceHealth?.ok && runtime?.preferences.map.includes(inferenceHealth.service)
    ? inferenceHealth.service : runtime?.preferences.map[0] || chosenBackend;
  const voiceStarted = useRef(null), voiceFirst = useRef(false);

  const handleInferenceHealth = useCallback(event => {
    setInferenceHealth(event);
    if (event?.ok) {
      setMapMetrics(prev => {
        const usage = event.usage || {};
        const inTok = Number(usage.input_tokens) || 0;
        const outTok = Number(usage.output_tokens) || 0;
        const callCost = Number.isFinite(Number(usage.cost_usd)) ? Number(usage.cost_usd) : null;
        const lastLatencyMs = event.latencyMs ?? prev?.lastLatencyMs ?? null;
        const tokensPerSec = outTok > 0 && lastLatencyMs > 50 ? Math.round((outTok / (lastLatencyMs / 1000)) * 10) / 10 : prev?.tokensPerSec ?? null;
        const sevenDay = summarizeSitesCosts(readSitesCostEntries(), '7d');
        return {
          provider: event.service || prev?.provider || '',
          model: event.model || prev?.model || '',
          lastLatencyMs,
          tokensPerSec,
          runs: (prev?.runs || 0) + 1,
          inputTokens: (prev?.inputTokens || 0) + inTok,
          outputTokens: (prev?.outputTokens || 0) + outTok,
          costUsd: callCost != null ? (prev?.costUsd || 0) + callCost : (prev?.costUsd ?? null),
          sevenDayCostUsd: sevenDay.hasReportedCost ? sevenDay.reportedCostUsd : null,
        };
      });
    }
  }, []);

  const [map, setMap] = useState(null), [panel, setPanel] = useState(null), [mapError, setMapError] = useState('');
  const [transcriptMinimized, setTranscriptMinimized] = useState(false), [transcriptFullscreen, setTranscriptFullscreen] = useState(false);
  const [speakerNames, setSpeakerNames] = useState({}), speakerNamesNow = useRef(speakerNames), mapNow = useRef(map);
  mapNow.current = map;
  const [mapSchedule, setMapSchedule] = useState(null), [mapNowRequest, setMapNowRequest] = useState(0);
  const [micStream, setMicStream] = useState(null), [micSilent, setMicSilent] = useState(false);
  const mapReady = useCallback(bundle => { const named = withSpeakerNames(bundle, speakerNamesNow.current); setMap(named); archive.update({ map: named }); setNotice('Conversation map updated.'); }, [archive.update]);
  const renameSpeaker = useCallback((speakerId, name) => {
    speakerNamesNow.current = { ...speakerNamesNow.current, [speakerId]: name };
    setSpeakerNames(speakerNamesNow.current);
    // Kept with the conversation, which is written to this device only when the user chose to save it here.
    archive.update({ speakerNames: speakerNamesNow.current });
    // An existing map takes the name at once; later maps take it as they arrive.
    if (!mapNow.current) return;
    const named = renameArtifactSpeaker(mapNow.current, speakerId, name);
    setMap(named); archive.update({ map: named });
  }, [archive.update]);
  const [transcriptionChoice, setTranscriptionChoice] = useState(null);
  const session = useRef(null), setupRequest = useRef(null), saveRequest = useRef(null), alive = useRef(true), stopControl = useRef(null), resumeControl = useRef(null);

  useEffect(() => {
    // Route updates during Start must not reload the prior saved recording over a new session.
    if (!localId || recording) { setRestoring(false); return; }
    let cancelled = false; setRestoring(true); setError('');
    readLocalConversation(localId).then(value => {
      if (cancelled) return;
      if (!value) throw new Error('This conversation is not saved in this browser.');
      setRecording(value.recording); setTranscript(value.transcript); setMap(value.map); setAudio(value.audio);
      speakerNamesNow.current = { ...Object.fromEntries(buildSpeakerDisplayNames(value.map)), ...savedSpeakerNames(value.speakerNames) }; setSpeakerNames(speakerNamesNow.current);
      setActivity({ stage: value.stage === 'stopped' ? 'stopped' : 'recovered', startedAt: value.updatedAt, message: 'Opened from this device. Your microphone is off.' });
      archive.restored(value);
      if (value.mapUnreadable) setNotice('Your audio and transcript are available. This saved map could not be read; its stored copy has not been changed. You can generate another map.');
    }).catch(failure => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [localId, recording?.id, archive.restored]);

  const checkCapabilities = useCallback(async () => {
    setupRequest.current?.abort();
    const controller = new AbortController(); setupRequest.current = controller;
    setSetup({ startedAt: Date.now() }); setError('');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const started = Date.now(); let outcome = 'error';
    try {
      const [transcription, storage] = await Promise.allSettled(
        ['/api/cloud/soniox/status', '/api/cloud/files/status'].map(path => abortable(controller.signal, async () => {
          const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('Recording setup is unavailable. Local audio recording is still available; retry setup for cloud features.');
          const value = await response.json();
          if (!value || typeof value.enabled !== 'boolean') throw new Error('Recording setup returned an unreadable response. Retry setup for cloud features.');
          return value;
        })),
      );
      const failed = [transcription, storage].find(result => result.status === 'rejected');
      outcome = controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : failed ? 'error' : 'success';
      if (alive.current && setupRequest.current === controller) {
        if (outcome !== 'cancelled') {
          setCapabilities({
            transcription: transcription.status === 'fulfilled' ? transcription.value : null,
            storage: storage.status === 'fulfilled' ? storage.value : null,
          });
        }
        if (failed) setError(controller.signal.aborted ? 'Setup stopped or timed out. Local recording is still available; retry setup for transcription and private saving.' : failed.reason.message);
      }
    } finally {
      window.clearTimeout(timeout);
      recordRecordingTiming('setup', 'setup', started, outcome);
      if (setupRequest.current === controller) { setupRequest.current = null; if (alive.current) setSetup(null); }
    }
  }, []);

  const refreshServices = useCallback(() => { void checkCapabilities(); }, [checkCapabilities]);

  useEffect(() => {
    alive.current = true; void checkCapabilities();
    return () => { alive.current = false; setupRequest.current?.abort(); saveRequest.current?.abort(); session.current?.cancel(); };
  }, [checkCapabilities]);
  useEffect(() => {
    const started = saveStartedAt || (ACTIVE.has(activity?.stage) ? activity.startedAt : setup?.startedAt || activity?.startedAt);
    const offset = activity?.stage === 'recording' ? activity.elapsedOffsetMs || 0 : 0;
    setElapsed(started ? Math.max(0, Math.floor((Date.now() - started + offset) / 1000)) : 0);
    if (!started || (!saveStartedAt && !setup && activity && !ACTIVE.has(activity.stage))) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started + offset) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [activity, setup, saveStartedAt]);

  function requestRecording(transcribe) {
    if (restoring || !supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    if ((audio || transcript.finalTokens.length) && archive.status.state !== 'saved' && !window.confirm('Start another recording? Download or save the current audio and transcript first. Starting again replaces them in this tab.')) return;
    setTranscriptionChoice(transcribe);
    setPendingRecording({ transcribe });
  }

  async function start(transcribe) {
    if (restoring || !supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    setPendingRecording(null);
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) { setError('This browser could not create a recording identifier. Retry in a supported browser.'); return; }
    session.current?.cancel(); setAudio(null); setMap(null); setMapError(''); setPanel(null); setTranscript(emptyTranscript); setError(''); setNotice('');
    speakerNamesNow.current = {}; setSpeakerNames({}); setMicStream(null); setMicSilent(false);
    const nextRecording = { id, startedAt: Date.now(), transcribe, retention: archive.preference };
    setRecording(nextRecording); archive.begin(nextRecording, archive.preference);
    navigate(archive.preference === 'local' ? `/new?local=${id}` : '/new', { replace: true });
    setVoiceHealth(null); setInferenceHealth(null); setVoiceMetrics(null); setMapMetrics(null); voiceStarted.current = Date.now(); voiceFirst.current = false;
    const useM5Live = transcribe && liveVoiceProvider === 'm5_tailnet';
    const next = useM5Live ? new M5TailnetLiveSession({
      url: runtime?.preferences.m5TailnetUrl,
      token: runtime?.keys.m5_tailnet,
      onStage: value => { if (alive.current && session.current === next) { setActivity(value); archive.update({ stage: value.stage }); } },
      onAudio: value => { if (alive.current && session.current === next) { setAudio(value); archive.update({ segments: value.segments.map(({ number, mimeType, complete, blob }) => ({ number, mimeType, complete, bytes: blob.size })) }); } },
      onAudioChunk: chunk => { if (alive.current && session.current === next) archive.append(chunk); },
      onTranscript: value => { if (alive.current && session.current === next) { setTranscript(value); archive.update({ transcript: value }); if (value.finalTokens.length) { const firstWords = !voiceFirst.current; voiceFirst.current = true; const ttftMs = Math.max(0, Date.now() - voiceStarted.current); setVoiceHealth({ service: 'm5_tailnet', ok: true, at: Date.now(), detail: firstWords ? `First words received in ${(ttftMs / 1000).toFixed(1)} s via M5 Tailnet.` : 'Receiving diarized chunks from M5 Tailnet.' }); } } },
      onMetrics: metrics => { if (alive.current && session.current === next) setVoiceMetrics({ ...metrics, lastWordAt: Date.now() }); },
      onMicStream: value => { if (alive.current && session.current === next) setMicStream(value); },
      onFailure: failure => { if (alive.current && session.current === next) { setError(failure.message); setVoiceHealth({ service: 'm5_tailnet', ok: false, at: Date.now(), detail: failure.message }); } },
    }) : new CloudConversationSession({
      onMicStream: value => { if (alive.current && session.current === next) setMicStream(value); },
      onStage: value => { if (alive.current && session.current === next) { setActivity(value); archive.update({ stage: value.stage }); } },
      onAudio: value => { if (alive.current && session.current === next) { setAudio(value); archive.update({ segments: value.segments.map(({ number, mimeType, complete, blob }) => ({ number, mimeType, complete, bytes: blob.size })) }); } },
      onAudioChunk: chunk => { if (alive.current && session.current === next) archive.append(chunk); },
      onTranscript: value => { if (alive.current && session.current === next) { setTranscript(value); archive.update({ transcript: value }); if (value.finalTokens.length || value.partialTokens.length) { const firstWords = !voiceFirst.current; voiceFirst.current = true; const now = Date.now(); const elapsedMs = Math.max(0, now - voiceStarted.current); const heardMs = heardAudioMs(value); setVoiceMetrics(prev => ({ provider: 'soniox', ttftMs: prev?.ttftMs ?? elapsedMs, lastLatencyMs: null, lastWordAt: now, audioSeconds: heardMs ? Math.round(heardMs / 1000) : prev?.audioSeconds ?? null, costUsd: heardMs ? (heardMs / 60_000) * 0.002 : prev?.costUsd ?? null })); setVoiceHealth({ service: 'soniox', ok: true, at: now, detail: firstWords ? `First words received after ${Math.round(elapsedMs / 1000)} s, including setup and waiting for speech.` : 'Transcript is receiving words from Soniox.' }); } } },
      onFailure: failure => { if (alive.current && session.current === next) { setError(failure.message); if (transcribe && failure.message.includes('live transcription')) setVoiceHealth({ service: 'soniox', ok: false, at: Date.now(), detail: 'Transcription stopped with an error. Your captured audio remains available.' }); } },
    });
    session.current = next;
    try {
      if (useM5Live) {
        await next.start();
      } else {
        const key = runtime?.keys.soniox;
        await next.start({ transcribe, maxSessionSeconds: transcribe ? capabilities.transcription.max_session_seconds : 300,
          ...(key ? { requestSession: ({ signal }) => requestTranscriptionSession({ signal, key }) } : {}) });
      }
    }
    catch (failure) { if (alive.current && session.current === next) setError(failure.message); }
  }

  async function savePrivate(file, subject) {
    if (!privateSaving || !file?.size || saving || generating || ACTIVE.has(activity?.stage)) return;
    const controller = new AbortController(); saveRequest.current = controller;
    const started = Date.now(); let outcome = 'error';
    setSaving(true); setSaveStartedAt(started); setSaveSubject(subject); setError(''); setNotice('');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    try {
      await abortable(controller.signal, () => privateRequest('/api/cloud/files', { method: 'POST', file, signal: controller.signal }));
      outcome = 'success';
      if (alive.current && !controller.signal.aborted) setNotice(`${subject} saved to your private cloud files.`);
    } catch (failure) {
      outcome = controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : 'error';
      if (alive.current) setError(controller.signal.aborted ? 'Saving stopped or timed out. Keep this file here and check your private files before retrying; the upload outcome may be uncertain.' : failure.message);
    } finally {
      window.clearTimeout(timeout); if (saveRequest.current === controller) saveRequest.current = null;
      recordRecordingTiming('saving', 'private-save', started, outcome);
      if (alive.current) { setSaving(false); setSaveStartedAt(null); }
    }
  }

  const active = ACTIVE.has(activity?.stage);
  const speechOrder = runtime?.preferences.speech || ['soniox'];
  const sonioxLive = (!runtime || speechOrder.includes('soniox')) && Boolean(runtime?.keys.soniox
    ? capabilities?.transcription?.personal_enabled : capabilities?.transcription?.enabled);
  const m5Live = Boolean(runtime?.preferences.speech?.includes('m5_tailnet'));
  const liveVoiceProvider = speechOrder.find(id => (id === 'm5_tailnet' && m5Live) || (id === 'soniox' && sonioxLive)) || 'soniox';
  const live = runtime?.credentialsReady !== false && (sonioxLive || m5Live);
  // A fast check stays silent; only one that runs past two seconds says so.
  const slowSetup = Boolean(setup && elapsed >= 2);
  const transcribe = transcriptionChoice ?? Boolean(live);
  useEffect(() => { if (active) stopControl.current?.focus(); }, [active]);
  useEffect(() => { if (activity?.stage === 'paused') resumeControl.current?.focus(); }, [activity?.stage]);
  const privateSaving = capabilities?.storage?.enabled && capabilities?.storage?.configured && !capabilities?.storage?.synthetic_only;
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  const complete = Boolean(audio?.complete && activity?.stage === 'stopped');
  const ready = Boolean(recording?.transcribe && transcript.finalTokens.length);
  const recordingArtifact = useMemo(() => {
    if (!ready) return null;
    const source = { recordingId: recording.id, startedAt: recording.startedAt, finalTokens: transcript.finalTokens, complete };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript file could not be prepared within its size or data limits. Your final text is still available to copy on this page.' }; }
  }, [ready, recording, transcript.finalTokens, complete]);
  const liveVoiceMetrics = useMemo(() => {
    const finalText = transcript.finalText || '';
    const words = finalText.trim() ? finalText.trim().split(/\s+/).length : 0;
    const speakers = new Set((transcript.finalTokens || []).map(t => t.speaker).filter(Boolean)).size;
    const audioBytes = audio?.blob?.size || (audio?.segments || []).reduce((sum, s) => sum + (s.blob?.size || s.bytes || 0), 0);
    // While recording, the page clock is the audio length; it excludes pauses. Afterwards, the last heard position.
    const secs = (activity?.stage === 'recording' ? elapsed : 0) || voiceMetrics?.audioSeconds || 0;
    const wpm = words >= 5 && secs >= 5 ? Math.round((words / secs) * 60) : null;
    if (!voiceMetrics && !words && !audioBytes) return null;
    return {
      provider: voiceMetrics?.provider || liveVoiceProvider,
      ttftMs: voiceMetrics?.ttftMs ?? null,
      lastLatencyMs: voiceMetrics?.lastLatencyMs ?? null,
      words,
      speakers: speakers || (words ? 1 : 0),
      wpm,
      lastWordAt: voiceMetrics?.lastWordAt ?? null,
      audioSeconds: secs || null,
      audioBytes: audioBytes || null,
      costUsd: voiceMetrics?.costUsd ?? null,
    };
  }, [voiceMetrics, transcript.finalText, transcript.finalTokens, audio, activity?.stage, elapsed, liveVoiceProvider]);

  const liveMapMetrics = useMemo(() => {
    const finalText = transcript.finalText || '';
    const wordsReady = finalText.trim() ? finalText.trim().split(/\s+/).length : 0;
    const configuredModel = runtime?.preferences?.mapChain?.[0]?.model || '';
    const sevenDay = summarizeSitesCosts(readSitesCostEntries(), '7d');
    if (!mapMetrics && !configuredModel && !wordsReady && !sevenDay.hasReportedCost) return null;
    return {
      provider: mapMetrics?.provider || backend,
      model: mapMetrics?.model || configuredModel || '',
      wordsReady,
      lastLatencyMs: mapMetrics?.lastLatencyMs ?? null,
      tokensPerSec: mapMetrics?.tokensPerSec ?? null,
      runs: mapMetrics?.runs || 0,
      inputTokens: mapMetrics?.inputTokens || 0,
      outputTokens: mapMetrics?.outputTokens || 0,
      costUsd: mapMetrics?.costUsd ?? null,
      sevenDayCostUsd: mapMetrics?.sevenDayCostUsd ?? (sevenDay.hasReportedCost ? sevenDay.reportedCostUsd : null),
    };
  }, [mapMetrics, transcript.finalText, runtime?.preferences?.mapChain, backend]);

  const showTranscript = Boolean(recording?.transcribe);
  const hasContent = Boolean(audio || map || transcript.finalTokens.length || transcript.partialTokens.length);
  const warnBeforeLeaving = active || (hasContent && archive.status.state !== 'saved');
  useEffect(() => {
    if (!warnBeforeLeaving) return;
    const protect = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [warnBeforeLeaving]);
  function guardNavigation(event) {
    const link = event.target.closest?.('a[href]');
    if (!warnBeforeLeaving || !link || link.hasAttribute('download') || link.target === '_blank') return;
    if (!window.confirm(LEAVE_WARNING)) event.preventDefault();
  }
  // Opening the map leaves this page, so it gets the same warning as any other way out.
  function exploreMap() {
    if (!map || (warnBeforeLeaving && !window.confirm(LEAVE_WARNING))) return;
    navigate('/view', { state: { generatedMapId: stageGeneratedMap(map), remember: false } });
  }
  const settled = !active && activity?.stage !== 'paused';
  return <main onClickCapture={guardNavigation} className="grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] font-sans text-slate-800">
    <ConversationNavigation panel={panel} onPanelChange={setPanel} mapUpdating={generating} mapError={mapError} />
    <section aria-label="Conversation canvas" tabIndex={0} className="relative flex min-h-0 flex-col overflow-hidden focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-slate-400">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 py-2 text-xs leading-5 text-slate-600">
        {archive.status.state === 'error' && <ConversationStorageStatus status={archive.status} preference={archive.preference} onRetry={archive.retry} />}
        {restoring && <p role="status">Opening saved conversation…</p>}
        {!supported && <p className="text-rose-800">This browser needs HTTPS, microphone access and audio-recording support.</p>}
        {(slowSetup || activity || saving) && <><p role="status">{saving ? `Saving ${saveSubject.toLowerCase()} to your private files` : active ? activity.message : slowSetup ? 'Checking connections' : activity.message}</p>{(slowSetup || active || saving) && <p className="tabular-nums">{elapsed} s elapsed · Time remaining unknown</p>}{slowSetup && <button className="min-h-8 underline underline-offset-2" onClick={() => setupRequest.current?.abort()}>Cancel connection check</button>}{saving && <button className="min-h-8 underline underline-offset-2" onClick={() => saveRequest.current?.abort()}>Cancel private save</button>}</>}
        {!setup && !active && activity?.stage !== 'paused' && !pendingRecording && !live && transcribe && <p>Live transcription is unavailable. Turn it off in <button className="underline underline-offset-2" onClick={() => setPanel('settings')}>Settings</button> to record audio only.</p>}
        {active && <p>Keep this tab open while recording.</p>}
        {active && micSilent && <p role="status" className="text-amber-800">No sound is reaching the microphone. Check which input your browser is using.</p>}
      </div>
      {error && <p role="alert" className="shrink-0 bg-rose-50 px-5 py-2 text-xs text-rose-900">{error}</p>}
      {notice && <p role="status" className="shrink-0 px-5 py-2 text-xs">{notice}</p>}
      <LiveConversationGraph bundle={map} transcriptVisible={showTranscript && !transcriptMinimized} onConfigure={() => setPanel('map')} recording={Boolean(recording)}>
        {showTranscript && panel !== 'map' && <LiveMapHeartbeat schedule={mapSchedule} finalText={transcript.finalText} onMapNow={() => setMapNowRequest(count => count + 1)} onOpenMap={() => setPanel('map')} />}
      </LiveConversationGraph>
      {showTranscript && <ConversationTranscriptPanel transcript={transcript} speakerNames={speakerNames} onRenameSpeaker={renameSpeaker} status={activity?.stage === 'paused' ? 'Paused' : active ? 'Live' : 'Finished'} minimized={transcriptMinimized}
        onMinimize={() => { setTranscriptMinimized(v => !v); setTranscriptFullscreen(false); }} fullscreen={transcriptFullscreen} onFullscreen={() => setTranscriptFullscreen(v => !v)} />}
      <aside hidden={!panel} aria-label="Conversation tools" className="absolute right-3 top-3 z-40 max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <CloseConversationTools onClose={() => setPanel(null)} />
        <div hidden={panel !== 'settings'}>
          <h2 className="pt-12 text-lg font-medium">Settings</h2>
          <ConversationTranscriptionSetting supported={supported} live={Boolean(live)}
            busy={restoring || saving || generating || active || activity?.stage === 'paused' || Boolean(pendingRecording)}
            transcribe={transcribe} onChange={setTranscriptionChoice} />
          {runtime ? <Link to="/settings/runtime" className="mt-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4">Manage transcription and intelligence providers</Link> : <>
            <label htmlFor="conversation-provider" className="mt-4 block text-sm">AI provider</label>
            <select id="conversation-provider" value={backend} disabled={generating} onChange={event => setBackend(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">
              {Object.entries(MAP_PROVIDERS).map(([value, provider]) => <option key={value} value={value}>{provider.option}</option>)}
            </select>
          </>}
          <button className="mt-4 min-h-11 text-sm underline underline-offset-4" disabled={Boolean(setup) || active} onClick={refreshServices}>Check connections</button>
          <p className="mt-3 text-xs text-slate-500">Connection and latency details are available from the two indicators below.</p>
          <ConversationStorageSettings preference={archive.preference} onChange={archive.choose} error={archive.preferenceError} />
          <div className="mt-4">{archive.status.state !== 'error' && <ConversationStorageStatus status={archive.status} preference={archive.preference} onRetry={archive.retry} />}</div>
        </div>
        <div hidden={panel !== 'map'}>
          {!recordingArtifact?.source && <p className="pt-12 text-sm text-slate-600">Start transcription to map your conversation. Confirmed words will be available here as you speak.</p>}
          {recordingArtifact?.source && <RecordingConversationMap savedBundle={map} retention={recording?.retention} backend={backend} onBackendChange={setBackend} onHealthChange={handleInferenceHealth} source={recordingArtifact.source} privateEnabled={privateSaving} saving={saving} onGeneratingChange={setGenerating} onMapChange={mapReady} onMapStatusChange={setMapError} onScheduleChange={setMapSchedule} mapNowRequest={mapNowRequest} onExplore={exploreMap} recordingBusy={active || activity?.stage === 'paused'} liveActive={activity?.stage === 'recording'} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />}
        </div>
        <div hidden={panel !== 'files'}>
          {map && <button className="min-h-11 text-sm underline underline-offset-4" onClick={() => setPanel('map')}>Download or save your map</button>}
          {!audio && !recordingArtifact && <p className="pt-12 text-sm text-slate-600">Your audio, transcript and map will be available here. Pause or stop to save audio.</p>}
          <RecordingAudioFiles retention={recording?.retention} audio={audio} recordingId={recording?.id} privateEnabled={privateSaving} busy={active || saving || generating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
          <RecordingTranscriptFiles retention={recording?.retention} artifact={recordingArtifact} privateEnabled={privateSaving} saving={active || saving || generating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
        </div>
      </aside>
    </section>
    <footer className="relative shrink-0 border-t border-gray-100 bg-white/80 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:px-4">
      <div className={active || activity?.stage === 'paused' ? "flex w-full items-center justify-between gap-2 max-[380px]:flex-col-reverse max-[380px]:items-stretch" : "grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"}>
        <ConversationServiceStatus
          backend={backend}
          voiceService={liveVoiceProvider}
          voice={voiceHealth}
          inference={inferenceHealth}
          voiceMetrics={liveVoiceMetrics}
          mapMetrics={liveMapMetrics}
          personalVoice={Boolean(runtime?.keys.soniox || liveVoiceProvider === 'm5_tailnet')}
          personalInference={Boolean(runtime?.keys[backend])}
          micStream={micStream}
          onMicSilentChange={setMicSilent}
        />
        <CloudRecordingToolbar active={active} supported={supported} live={Boolean(live)} busy={restoring || saving || generating} stage={activity?.stage} stopRef={stopControl} resumeRef={resumeControl} transcribe={transcribe} onStart={() => requestRecording(transcribe)} onPause={() => void session.current?.pause()} onResume={() => { setError(''); void session.current?.resume().catch(failure => setError(failure.message)); }} onStop={() => void session.current?.stop()} onCancel={() => session.current?.cancel()} />
        {settled && map && <div className="flex min-w-0 justify-end">
          <button type="button" aria-label="Explore map" onClick={exploreMap} disabled={restoring || saving || generating}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
            <Compass size={16} aria-hidden="true" /><span className="sm:hidden">Explore</span><span className="hidden sm:inline">Explore map</span>
          </button>
        </div>}
      </div>
    </footer>
    {pendingRecording && <RecordingConsentDialog retention={archive.preference} transcribe={pendingRecording.transcribe} maxSeconds={capabilities?.transcription?.max_session_seconds} onCancel={() => setPendingRecording(null)} onConfirm={() => void start(pendingRecording.transcribe)} />}
  </main>;
}
