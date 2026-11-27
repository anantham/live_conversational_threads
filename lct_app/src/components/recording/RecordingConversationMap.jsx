import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { describeModelRoute, getRecordingMapStatus, generateRecordingMap, getOrderedMapStatus, generateOrderedRecordingMap, configuredMapRoutes, MAP_PROVIDERS } from '../../services/cloud/openRouterClient.js';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { useCloudTask } from '../../hooks/useCloudTask.js';
import PublicTaskStatus from '../PublicTaskStatus.jsx';
import PrivateRetentionNotice from '../PrivateRetentionNotice.jsx';
import { createRecordingThreads } from '../../services/cloud/recordingThreads.js';
import { stageGeneratedMap } from '../../services/cloud/generatedMapHandoff.js';
import { MIN_NEW_MAP_CHARS } from './liveMapHeartbeatModel.js';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const interrupted = 'Waiting stopped. The attempt may still be running or counted; stopping this view does not confirm billing stopped. Keep your transcript and check setup before a deliberate retry.';

export default function RecordingConversationMap({ localOnly = false, source, savedBundle, retention = 'ephemeral', backend: selectedBackend, onBackendChange, onHealthChange, privateEnabled, saving, onPrivateSave, onGeneratingChange, onMapChange, onMapStatusChange, liveActive = false, recordingBusy = false, onMapAttempt, stopSignal, onScheduleChange, mapNowRequest = 0 }) {
  const runtime = useSitesRuntime();
  const routes = useMemo(() => runtime ? configuredMapRoutes(runtime) : null, [runtime]);
  const hasPersonalRoute = useMemo(() => Boolean(routes?.some(route => route.key)), [routes]);
  const maxAutoAttempts = hasPersonalRoute ? 20 : 6;
  const autoIntervalMs = hasPersonalRoute ? 25_000 : 45_000;
  const [served, setServed] = useState(null);
  const [localBackend, setLocalBackend] = useState('openrouter');
  const backend = selectedBackend ?? localBackend;
  const setBackend = value => { setLocalBackend(value); onBackendChange?.(value); };
  const [automatic, setAutomatic] = useState(false), [attemptCount, setAttemptCount] = useState(0);
  const userToggledAuto = useRef(false);
  const generateLatest = useRef(null), downloadURLs = useRef(new Set());
  const lastAttempt = useRef(0), lastText = useRef(''), generating = useRef(false), attempts = useRef(0);
  const [checkedStatus, setStatus] = useState(null), [consentedBackend, setConsent] = useState(null);
  const routeSelection = routes || backend;
  const status = checkedStatus?.selection === routeSelection ? checkedStatus.data : null;
  const consent = consentedBackend === routeSelection || (hasPersonalRoute && Boolean(status?.enabled));
  const recipients = routes
    ? [...new Set(routes.map(({ backend }) => MAP_PROVIDERS[backend].recipient))].join(', ')
    : MAP_PROVIDERS[backend].recipient;
  const [result, setResult] = useState(null), [error, setError] = useState(''), [url, setURL] = useState('');
  const { run, cancel, activity, elapsed } = useCloudTask('recording-map');
  const alive = useRef(true), currentSource = useRef(source), statusEpoch = useRef(0);
  currentSource.current = source;
  const navigate = useNavigate();
  const checkStatus = useCallback(async () => {
    setError('');
    const epoch = ++statusEpoch.current;
    const response = await run('load', signal => routes ? getOrderedMapStatus(signal, routes) : getRecordingMapStatus(signal, backend));
    if (!alive.current || epoch !== statusEpoch.current) return;
    if (response.data) setStatus({ selection: routeSelection, data: response.data });
    else { setStatus(null); setError(response.outcome === 'cancelled' || response.outcome === 'timeout'
      ? 'Generation setup stopped or timed out. Keep the transcript and retry setup.' : 'Generation setup is unavailable. Recording and local downloads remain available. Retry generation setup.'); }
  }, [run, backend, routes, routeSelection]);
  useEffect(() => {
    alive.current = true; setConsent(null); setStatus(null); void checkStatus();
    return () => { alive.current = false; cancel(); };
  }, [source.recordingId, checkStatus, cancel]);
  useEffect(() => { setResult(null); setServed(null); setAutomatic(false); userToggledAuto.current = false; attempts.current = 0; setAttemptCount(0); lastText.current = ''; lastAttempt.current = 0; }, [source.recordingId]);
  useEffect(() => { setAutomatic(false); userToggledAuto.current = false; }, [routeSelection]);
  useEffect(() => {
    if (hasPersonalRoute && liveActive && status?.available && !userToggledAuto.current && !automatic) {
      setAutomatic(true);
    }
  }, [hasPersonalRoute, liveActive, status?.available, automatic]);
  useEffect(() => {
    const stop = () => { setAutomatic(false); cancel(); };
    stopSignal?.addEventListener('abort', stop, { once: true });
    if (stopSignal?.aborted) stop();
    return () => stopSignal?.removeEventListener('abort', stop);
  }, [stopSignal, cancel]);
  useEffect(() => {
    if (!savedBundle || result?.bundle === savedBundle || savedBundle.conversation_id !== source.recordingId) return;
    const json = JSON.stringify(savedBundle), filename = `recording-${source.recordingId}.threads`;
    setResult({ bundle: savedBundle, json, filename, file: new File([json], filename, { type: 'application/json' }) });
  }, [savedBundle, source.recordingId, result?.bundle]);
  useEffect(() => { onMapStatusChange?.(error); }, [error, onMapStatusChange]);
  useEffect(() => { onGeneratingChange(activity === 'generate'); return () => onGeneratingChange(false); }, [activity, onGeneratingChange]);
  useEffect(() => {
    if (!result) { setURL(''); return; }
    const next = URL.createObjectURL(result.file); downloadURLs.current.add(next); setURL(next);
    // Keep prior snapshot downloads valid through a simultaneous map update.
  }, [result]);
  useEffect(() => { const urls = downloadURLs.current; return () => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); }; }, []);
  useEffect(() => {
    if (!source.complete || !result || result.bundle.transcription_complete || result.bundle.full_transcript !== source.finalTokens.map(t => t.text).join('')) return;
    const bundle = result.bundle;
    const completed = createRecordingThreads({ ...source, graph: { nodes: bundle.graph_data, edges: bundle.edges,
      metadata: { conversation_title: bundle.conversation_title, executive_summary: bundle.executive_summary }, conversation_threads: bundle.conversation_threads } });
    setResult(completed); onMapChange?.(completed.bundle);
  }, [source, result, onMapChange]);
  async function generate(fromTimer = false) {
    if (fromTimer && (!automatic || attempts.current >= maxAutoAttempts)) { setAutomatic(false); return; }
    if (stopSignal?.aborted || !consent || !status?.enabled || !status.available || activity || generating.current || saving) return;
    const requestedSource = source;
    generating.current = true;
    onMapAttempt?.();
    lastAttempt.current = Date.now();
    lastText.current = requestedSource.finalTokens.map(t => t.text).join('');
    attempts.current++;
    setAttemptCount(attempts.current);
    setError('');
    const healthStarted = Date.now();
    const response = await run('generate', signal => routes
      ? generateOrderedRecordingMap(requestedSource, signal, routes, runtime.preferences.guidance)
      : generateRecordingMap(requestedSource, signal, backend));
    generating.current = false;
    if (!alive.current || stopSignal?.aborted || currentSource.current.recordingId !== requestedSource.recordingId) return;
    const latencyMs = Math.max(0, Date.now() - healthStarted);
    onHealthChange?.({
      service: response.data?.backend || backend,
      ok: response.data ? true : ['cancelled', 'timeout'].includes(response.outcome) ? null : false,
      at: Date.now(),
      detail: response.data ? `Last map completed in ${(latencyMs / 1000).toFixed(1)} s.` : 'Map generation did not complete. Check the map panel for details.',
      model: response.data?.model || '',
      latencyMs: response.data ? latencyMs : null,
      usage: response.data?.usage || null,
    });
    if (response.data) {
      setResult(response.data);
      setServed(response.data.backend ? `${MAP_PROVIDERS[response.data.backend].name} · ${response.data.model}` : null);
      onMapChange?.(response.data.bundle);
    }
    else { setAutomatic(false); setError(response.outcome === 'cancelled' || response.outcome === 'timeout' ? interrupted : response.error.message); }
  }
  generateLatest.current = generate;
  // The canvas shows this schedule while the panel is closed. It carries counts and times only, never transcript text.
  const scheduleState = activity === 'generate' ? 'mapping'
    : !status?.enabled || !status.available ? 'unavailable'
    : !consent ? 'needs-consent'
    : error ? 'error'
    : attemptCount >= maxAutoAttempts ? 'limit'
    : automatic && (liveActive || source.complete) ? 'scheduled' : 'manual';
  const canMapNow = Boolean(consent && status?.enabled && status.available && !activity && !saving);
  useEffect(() => {
    onScheduleChange?.({ state: scheduleState, canMapNow, complete: source.complete, lastAttemptAt: lastAttempt.current,
      mappedChars: lastText.current.length, intervalMs: autoIntervalMs, minNewChars: MIN_NEW_MAP_CHARS,
      attemptsUsed: attemptCount, maxAttempts: maxAutoAttempts });
  }, [scheduleState, canMapNow, source.complete, source.recordingId, attemptCount, autoIntervalMs, maxAutoAttempts, onScheduleChange]);
  useEffect(() => () => onScheduleChange?.(null), [onScheduleChange]);
  // A deliberate request from the canvas. It counts as an attempt, like the button in this panel.
  const handledMapNow = useRef(mapNowRequest);
  useEffect(() => {
    if (mapNowRequest === handledMapNow.current) return;
    handledMapNow.current = mapNowRequest;
    void generateLatest.current();
  }, [mapNowRequest]);
  useEffect(() => {
    if (!automatic || !consent || !status?.available || activity || saving || attempts.current >= maxAutoAttempts || (!liveActive && !source.complete)) return;
    const timer = window.setInterval(() => {
      const text = currentSource.current.finalTokens.map(t => t.text).join('');
      const enough = currentSource.current.complete ? text !== lastText.current : text.length - lastText.current.length >= MIN_NEW_MAP_CHARS;
      if (enough && Date.now() - lastAttempt.current >= autoIntervalMs) void generateLatest.current(true);
    }, 1000);
    return () => window.clearInterval(timer);
  // Transcript events update the snapshot without restarting the scheduling clock.
  }, [automatic, consent, status, activity, saving, liveActive, source.recordingId, source.complete, backend, attemptCount, maxAutoAttempts, autoIntervalMs]);
  return <section aria-label="Conversation map" className="mt-8 border-t border-slate-200 pt-6">
    <h2 className="text-lg font-medium">AI map</h2>
    <p className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Turn finalized words into a map linked to their source. {source.complete ? 'The recording is complete.' : 'This is a partial transcript; unfinished words are excluded.'} {retention === 'local' ? 'The map saves in this browser; it is never published automatically.' : 'Generation does not save or publish it.'}</p>
    {routes ? <div className="mt-3 text-sm leading-6 text-slate-600">
      <p>{routes.map(({ backend, model }) => model ? `${MAP_PROVIDERS[backend].name} (${model})` : MAP_PROVIDERS[backend].name).join(' → ')}</p>
      <Link className="underline underline-offset-4" to="/settings/runtime">Manage provider order and keys</Link>
    </div> : <>
    <label className="mt-4 block text-sm font-medium" htmlFor="map-inference-backend">AI provider</label>
    <select id="map-inference-backend" className="mt-2 min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm" value={backend} disabled={Boolean(activity) || saving} onChange={event => { setConsent(null); setStatus(null); setBackend(event.target.value); }}>
      {['gemini', 'openrouter', 'anthropic'].map(value => <option key={value} value={value}>{MAP_PROVIDERS[value].option}</option>)}
    </select>
    </>}
    {status?.models?.length > 0 && <ul className="mt-2 text-sm text-slate-600">{status.models.map(model => <li key={model}>{model}</li>)}</ul>}
    {status?.model && <p className="mt-3 break-words text-sm text-slate-600">{describeModelRoute(status)}</p>}
    {!activity && !status?.enabled && <p className="mt-3 text-sm leading-6 text-slate-600">Generation is waiting for provider setup and confirmed spending limits. Transcript download remains available.</p>}
    {status?.enabled && !status.available && <p className="mt-3 text-sm leading-6 text-slate-600">Shared generation capacity is unavailable. Check setup again before retrying; unresolved attempts may need owner review.</p>}
    {status?.audience === 'authenticated' && <p className="mt-3 text-sm text-slate-600">This generation test requires sign-in. <Link className="underline underline-offset-4" to="/private-files">Sign in from Private files</Link></p>}
    <label className="mt-4 flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1" checked={consent} disabled={Boolean(activity) || saving || !status?.enabled} onChange={event => { setConsent(event.target.checked ? routeSelection : null); if (!event.target.checked) setAutomatic(false); }} />I have permission to send these finalized words to {recipients} to generate a map. Their processing policies apply.</label>
    <label className="mt-3 flex items-start gap-3 text-sm leading-6"><input type="checkbox" aria-label="Update map while I speak" className="mt-1" checked={automatic} disabled={!consent || !status?.available || attempts.current >= maxAutoAttempts} onChange={event => { userToggledAuto.current = true; setAutomatic(event.target.checked); }} />Update map while I speak</label>
    <p className="mt-1 text-xs leading-5 text-slate-500">Updates use new confirmed words, at most once every {Math.round(autoIntervalMs / 1000)} seconds. Automatic updates stop after {maxAutoAttempts} attempts per conversation. {attemptCount > 0 && `${attemptCount} attempts used.`}</p>
    {attemptCount >= maxAutoAttempts && <p role="status" className="mt-2 text-xs text-slate-600">Automatic updates have reached their limit. You can still request a map deliberately if shared capacity is available.</p>}
    <div className="mt-4 flex flex-wrap gap-3"><button className={`${button} border-slate-900 bg-slate-900 text-white`} disabled={!consent || !status?.available || Boolean(activity) || saving} onClick={() => void generate()}>{result ? 'Generate another map' : 'Generate conversation map'}</button><button className={button} disabled={Boolean(activity) || saving} onClick={() => void checkStatus()}>Retry generation setup</button></div>
    <PublicTaskStatus activity={activity} elapsed={elapsed} cancel={cancel} loadingLabel="Checking generation setup" />
    {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-900">{error}</p>}
    {result && <div className="mt-6">
      {served && <p className="text-sm text-slate-600">Generated by {served}</p>}
      {result.bundle.full_transcript !== source.finalTokens.map(t => t.text).join('') && <p className="text-xs text-amber-800">The map covers an earlier snapshot. New words are waiting for the next update.</p>}
      <p role="status" className="text-sm leading-6">{retention === 'local' ? 'Your map is ready. Browser saving status appears above; you can also download a copy.' : 'Your map is ready in this tab. Download audio, transcript and map before leaving the recording page.'}</p>
      {!localOnly && <PrivateRetentionNotice id="map-private-retention" />}
      <div className="mt-4 flex flex-wrap gap-3"><button className={button} disabled={Boolean(activity) || saving || recordingBusy} onClick={() => navigate('/view', { state: { generatedMapId: stageGeneratedMap(result.bundle), remember: false } })}>Explore map</button>{url && <a className={button} href={url} download={result.filename}>Download map</a>}{!localOnly && <button className={button} aria-describedby="map-private-retention" disabled={!privateEnabled || Boolean(activity) || saving || liveActive} onClick={() => onPrivateSave(result.file, 'Map')}>Save map privately</button>}</div>
      {!localOnly && !privateEnabled && <p className="mt-3 text-sm text-slate-600">Private saving needs sign-in and enabled personal storage. You can download this map now.</p>}
      {!localOnly && <p className="mt-3 text-sm leading-6 text-slate-600">To share a public copy, download the map and use <Link className="underline underline-offset-4" to="/public">Public conversations</Link>. That step has separate confirmation and file limits.</p>}
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Copy map data if download is unavailable</summary><label htmlFor="recording-map-json" className="mt-3 block">Conversation map JSON</label><textarea id="recording-map-json" readOnly value={result.json} rows={5} className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm" /></details>
    </div>}
  </section>;
}

RecordingConversationMap.propTypes = { localOnly: PropTypes.bool, savedBundle: PropTypes.object, retention: PropTypes.string, backend: PropTypes.string, onBackendChange: PropTypes.func, onHealthChange: PropTypes.func, source: PropTypes.object.isRequired, privateEnabled: PropTypes.bool,
  saving: PropTypes.bool.isRequired, onPrivateSave: PropTypes.func.isRequired, onGeneratingChange: PropTypes.func.isRequired, onMapChange: PropTypes.func, onMapStatusChange: PropTypes.func, liveActive: PropTypes.bool, recordingBusy: PropTypes.bool, onMapAttempt: PropTypes.func, stopSignal: PropTypes.object,
  onScheduleChange: PropTypes.func, mapNowRequest: PropTypes.number };
