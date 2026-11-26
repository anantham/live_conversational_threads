import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AudioImportSession } from '../services/cloud/AudioImportSession.js';
import { importWait } from '../services/cloud/audioImportFile.js';
import { OpenAIFileSession } from '../services/cloud/openAiFileSession.js';
import { DEFAULT_M5_TAILNET_URL, M5TailnetFileSession } from '../services/cloud/m5TailnetFileSession.js';
import { SPEECH_PROVIDERS } from '../services/cloud/sitesProviderPreferences.js';
import { readEdgeConfig } from '../components/audio/edgeConfig.js';
import { requestTranscriptionSession } from '../services/cloud/sonioxSessionClient.js';
import { useSitesRuntime } from '../contexts/SitesRuntimeContext';
import { getRecordingMapStatus, generateRecordingMap, configuredMapRoutes, getOrderedMapStatus, generateOrderedRecordingMap } from '../services/cloud/openRouterClient.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { useConversationArchive } from './useConversationArchive.js';
import { useCloudTask } from './useCloudTask.js';
const empty = () => ({ finalText: '', partialText: '', finalTokens: [], partialTokens: [] });

export function useAudioImport() {
  const archive = useConversationArchive(), location = useLocation(), navigate = useNavigate();
  const runtime = useSitesRuntime();
  const [file, setFile] = useState(null), [consentSelection, setConsentSelection] = useState(null), [backend, setBackend] = useState('openrouter');
  const [recording, setRecording] = useState(null), [audio, setAudio] = useState(null), [transcript, setTranscript] = useState(empty);
  const [map, setMap] = useState(null), [activity, setActivity] = useState(null), [error, setError] = useState('');
  // Says which provider failed and which one received the audio instead, and stays up after the run.
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [setupError, setSetupError] = useState('');
  const [capability, setCapability] = useState(null), [loading, setLoading] = useState(true), [elapsed, setElapsed] = useState(0);
  const task = useCloudTask('recording-map');
  const [mapStopSignal, setMapStopSignal] = useState(null);
  const mapStop = useRef(null), liveMapClaimed = useRef(false), setup = useRef(null);
  const claimLiveMap = useCallback(() => { liveMapClaimed.current = true; }, []);
  const running = useRef(false), current = useRef(null), alive = useRef(true), epoch = useRef(0);
  const localId = new URLSearchParams(location.search).get('local');
  // A notice about an earlier run does not describe a newly chosen file or a reopened conversation.
  useEffect(() => { if (!running.current) setFallbackNotice(''); }, [file, localId]);
  const busy = ['preparing', 'authorizing', 'connecting', 'transcribing', 'finalizing', 'mapping'].includes(activity?.stage);
  const edgeConfig = readEdgeConfig(location.search);
  const configuredSpeech = runtime ? runtime.preferences.speech.filter(id => id === 'soniox'
    ? runtime.keys.soniox ? capability?.personal_enabled : capability?.enabled
    : id === 'm5_tailnet' ? true : runtime.keys.openai) : capability?.enabled ? ['soniox'] : [];
  const speechProviders = runtime?.credentialsReady === false
    ? []
    : edgeConfig.enabled && !configuredSpeech.includes('m5_tailnet')
      ? ['m5_tailnet', ...configuredSpeech]
      : configuredSpeech;
  const speechSelection = speechProviders.join(',');
  const consent = consentSelection?.routes === (runtime || backend) && consentSelection.speech === speechSelection;
  const setConsent = value => setConsentSelection(value ? { routes: runtime || backend, speech: speechSelection } : null);
  const mapRoutes = runtime ? configuredMapRoutes(runtime) : null;

  const check = useCallback(async () => {
    setup.current?.abort();
    const controller = new AbortController();
    setup.current = controller;
    setLoading(true);
    try {
      const value = await importWait((async () => {
        const response = await fetch('/api/cloud/soniox/status', { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        const status = await response.json();
        if (!response.ok || typeof status?.enabled !== 'boolean' || !Number.isInteger(status.max_session_seconds) ||
            status.max_session_seconds < 15 || status.max_session_seconds > 900) throw new Error('Transcription setup is unavailable.');
        return status;
      })(), controller.signal);
      if (alive.current && setup.current === controller) { setCapability(value); setSetupError(''); }
    } catch {
      if (alive.current && setup.current === controller) {
        setCapability(null);
        setSetupError('Transcription setup could not be checked. Your file has not been sent.');
      }
    } finally {
      controller.abort();
      if (setup.current === controller) {
        setup.current = null;
        if (alive.current) setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true; void check();
    return () => { alive.current = false; setup.current?.abort(); epoch.current++; current.current?.cancel(); mapStop.current?.abort(); };
  }, [check]);
  useEffect(() => {
    if (!localId || recording) return;
    let cancelled = false;
    readLocalConversation(localId).then(value => {
      if (cancelled || !alive.current) return;
      if (!value) throw new Error('This import is not saved in this browser.');
      setRecording(value.recording); setAudio(value.audio); setTranscript(value.transcript); setMap(value.map);
      if (value.mapUnreadable) {
        const temporary = { ...value.recording, retention: 'ephemeral' };
        setRecording(temporary); archive.begin(temporary, 'ephemeral');
        setError('The saved map could not be read. Its stored copy is unchanged; this tab will not overwrite it. Download available files before leaving.');
      } else archive.restored(value);
      setActivity({ stage: value.stage === 'stopped' ? 'complete' : 'cancelled',
        message: value.stage === 'stopped' ? 'Opened from this device.' : 'Previous import interrupted. Your saved audio and confirmed words are available.' });
    }).catch(error => { if (!cancelled && alive.current) setError(error.message); });
    return () => { cancelled = true; };
  }, [localId, recording, archive.restored]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const mapReady = useCallback(bundle => { setMap(bundle); archive.update({ map: bundle }); }, [archive.update]);
  async function start() {
    if (running.current || !file || !consent || busy || loading || !speechProviders.length) return;
    running.current = true;
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) { running.current = false; setError('This browser cannot create a conversation identifier. No file was sent.'); return; }
    const generation = ++epoch.current;
    mapStop.current?.abort(); mapStop.current = new AbortController();
    setMapStopSignal(mapStop.current.signal); liveMapClaimed.current = false;
    const next = { id, startedAt: Date.now(), transcribe: true, retention: archive.preference,
      source: 'audio-import', originalFilename: file.name.slice(0, 240) };
    setRecording(next); setAudio(null); setMap(null); setTranscript(empty()); setError(''); setFallbackNotice('');
    archive.begin(next, next.retention);
    navigate(next.retention === 'local' ? '/import-audio?local=' + id : '/import-audio', { replace: true });
    const valid = () => alive.current && epoch.current === generation;
    let audioKept = false;
    const callbacks = {
      onStage: value => { if (valid()) { setActivity(value); archive.update({ stage: value.stage }); } },
      onAudio: value => { if (valid() && !audioKept) {
        audioKept = true;
        setAudio(value); archive.append({ segment: 1, index: 0, mimeType: value.mimeType, blob: value.blob });
        archive.update({ segments: [{ number: 1, mimeType: value.mimeType, complete: true, bytes: value.blob.size }] });
      } },
      onTranscript: value => { if (valid()) { setTranscript(value); archive.update({ transcript: value }); } },
    };
    try {
      let words;
      // Every provider that failed before the one that worked, said out loud in order.
      const failures = [];
      const providerName = id => SPEECH_PROVIDERS[id]?.name || id;
      const failureText = () => failures.map(({ name, message }) => `${name} could not transcribe this file (${message}).`).join(' ');
      for (const [index, provider] of speechProviders.entries()) {
        const key = runtime?.keys[provider];
        const session = provider === 'm5_tailnet'
          ? new M5TailnetFileSession({
              ...callbacks,
              // Settings is the one place this address is chosen, and it shows the build default when
              // empty, so the address used is the one on screen. An `edge_url` stored by an old link
              // (for live recording) never redirects file imports.
              url: runtime?.preferences?.m5TailnetUrl || DEFAULT_M5_TAILNET_URL,
              token: key || edgeConfig.token,
              diarize: true,
            })
          : provider === 'openai'
            ? new OpenAIFileSession({ ...callbacks, key })
            : new AudioImportSession({ ...callbacks,
              ...(key ? { requestSession: ({ signal }) => requestTranscriptionSession({ signal, key }) } : {}) });
        current.current = session;
        try {
          words = await session.start({ file, maxSessionSeconds: capability?.max_session_seconds });
          if (failures.length && valid()) setFallbackNotice(`${failureText()} It was transcribed by ${providerName(provider)} instead, the next provider in the order you agreed to.`);
          break;
        } catch (error) {
          if (!valid() || mapStop.current?.signal.aborted || !error.canTryNext || index === speechProviders.length - 1) throw error;
          console.warn(`[useAudioImport] ${provider} failed; trying ${speechProviders[index + 1]}:`, error);
          failures.push({ name: providerName(provider), message: String(error.message || error).replace(/\.$/, '') });
          setFallbackNotice(`${failureText()} Trying ${providerName(speechProviders[index + 1])} next, the next provider in the order you agreed to.`);
        }
      }
      if (!valid()) return;
      archive.update({ stage: 'stopped' });
      // One owner: an explicit live attempt must never gain an implicit final retry.
      if (liveMapClaimed.current) {
        setActivity({ stage: 'complete', message: 'Audio and transcript are ready. Check AI map for live thread updates.' });
        return;
      }
      const source = { recordingId: id, startedAt: next.startedAt, finalTokens: words.finalTokens, complete: true };
      setActivity({ stage: 'mapping', message: 'Creating threads from your transcript.' });
      const response = await task.run('generate', async signal => {
        const status = mapRoutes ? await getOrderedMapStatus(signal, mapRoutes) : await getRecordingMapStatus(signal, backend);
        if (!status.enabled || !status.available) throw new Error('Your transcript is ready. Threads are unavailable within the current shared limits; no generation request was sent.');
        return mapRoutes ? generateOrderedRecordingMap(source, signal, mapRoutes, runtime.preferences.guidance)
          : generateRecordingMap(source, signal, backend);
      });
      if (!valid()) return;
      if (response.data) mapReady(response.data.bundle);
      else setError(['cancelled', 'timeout'].includes(response.outcome)
        ? 'Stopped waiting for threads. The request may still be running or counted. Your audio and transcript are preserved.'
        : response.error.message);
      setActivity({ stage: 'complete', message: response.data ? 'Audio, transcript and threads are ready.' : 'Audio and transcript are ready.' });
    } catch (failure) {
      mapStop.current?.abort();
      if (valid() && failure.name !== 'AbortError') setError(failure.message);
    } finally { running.current = false; }
  }
  function cancel() { current.current?.cancel(); mapStop.current?.abort(); task.cancel(); }
  return { archive, file, setFile, consent, setConsent, backend, setBackend, recording, audio, transcript, map, fallbackNotice,
    mapReady, claimLiveMap, mapStopSignal, activity, busy, loading, elapsed, error: error || (speechProviders.length ? '' : setupError), capability, speechProviders, mapRoutes, check, start, cancel };
}
