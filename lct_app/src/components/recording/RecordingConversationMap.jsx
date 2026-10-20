import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { getRecordingMapStatus, generateRecordingMap } from '../../services/cloud/openRouterClient.js';
import { useCloudTask } from '../../hooks/useCloudTask.js';
import PublicTaskStatus from '../PublicTaskStatus.jsx';
import PrivateRetentionNotice from '../PrivateRetentionNotice.jsx';
import { createRecordingThreads } from '../../services/cloud/recordingThreads.js';
import { stageGeneratedMap } from '../../services/cloud/generatedMapHandoff.js';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const interrupted = 'Waiting stopped. The attempt may still be running or counted; stopping this view does not confirm billing stopped. Keep your transcript and check setup before a deliberate retry.';

export default function RecordingConversationMap({ localOnly = false, source, savedBundle, retention = 'ephemeral', backend: selectedBackend, onBackendChange, onHealthChange, privateEnabled, saving, onPrivateSave, onGeneratingChange, onMapChange, onMapStatusChange, liveActive = false, recordingBusy = false }) {
  const [localBackend, setLocalBackend] = useState('openrouter');
  const backend = selectedBackend ?? localBackend;
  const setBackend = value => { setLocalBackend(value); onBackendChange?.(value); };
  const [automatic, setAutomatic] = useState(false), [attemptCount, setAttemptCount] = useState(0);
  const generateLatest = useRef(null), downloadURLs = useRef(new Set());
  const lastAttempt = useRef(0), lastText = useRef(''), generating = useRef(false), attempts = useRef(0);
  const [status, setStatus] = useState(null), [consent, setConsent] = useState(false);
  const [result, setResult] = useState(null), [error, setError] = useState(''), [url, setURL] = useState('');
  const { run, cancel, activity, elapsed } = useCloudTask('recording-map');
  const alive = useRef(true), currentSource = useRef(source), statusEpoch = useRef(0);
  currentSource.current = source;
  const navigate = useNavigate();
  const checkStatus = useCallback(async () => {
    setError('');
    const epoch = ++statusEpoch.current;
    const response = await run('load', signal => getRecordingMapStatus(signal, backend));
    if (!alive.current || epoch !== statusEpoch.current) return;
    if (response.data) setStatus(response.data);
    else { setStatus(null); setError(response.outcome === 'cancelled' || response.outcome === 'timeout'
      ? 'Generation setup stopped or timed out. Keep the transcript and retry setup.' : 'Generation setup is unavailable. Recording and local downloads remain available. Retry generation setup.'); }
  }, [run, backend]);
  useEffect(() => {
    alive.current = true; setConsent(false); setStatus(null); void checkStatus();
    return () => { alive.current = false; cancel(); };
  }, [source.recordingId, checkStatus, cancel]);
  useEffect(() => { setResult(null); setAutomatic(false); attempts.current = 0; setAttemptCount(0); lastText.current = ''; lastAttempt.current = 0; }, [source.recordingId]);
  useEffect(() => { setAutomatic(false); }, [backend]);
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
    if (fromTimer && (!automatic || attempts.current >= 6)) { setAutomatic(false); return; }
    if (!consent || !status?.enabled || !status.available || activity || generating.current || saving) return;
    const requestedSource = source;
    generating.current = true;
    lastAttempt.current = Date.now();
    lastText.current = requestedSource.finalTokens.map(t => t.text).join('');
    attempts.current++;
    setAttemptCount(attempts.current);
    setError('');
    const healthStarted = Date.now();
    const response = await run('generate', signal => generateRecordingMap(requestedSource, signal, backend));
    generating.current = false;
    if (!alive.current || currentSource.current.recordingId !== requestedSource.recordingId) return;
    onHealthChange?.({ service: backend, ok: response.data ? true : ['cancelled', 'timeout'].includes(response.outcome) ? null : false, at: Date.now(), detail: response.data ? `Last map completed in ${((Date.now() - healthStarted) / 1000).toFixed(1)} s.` : 'Map generation did not complete. Check the map panel for details.' });
    if (response.data) { setResult(response.data); onMapChange?.(response.data.bundle); }
    else { setAutomatic(false); setError(response.outcome === 'cancelled' || response.outcome === 'timeout' ? interrupted : response.error.message); }
  }
  generateLatest.current = generate;
  useEffect(() => {
    if (!automatic || !consent || !status?.available || activity || saving || attempts.current >= 6 || (!liveActive && !source.complete)) return;
    const timer = window.setInterval(() => {
      const text = currentSource.current.finalTokens.map(t => t.text).join('');
      const enough = currentSource.current.complete ? text !== lastText.current : text.length - lastText.current.length >= 120;
      if (enough && Date.now() - lastAttempt.current >= 45_000) void generateLatest.current(true);
    }, 1000);
    return () => window.clearInterval(timer);
  // Transcript events update the snapshot without restarting the scheduling clock.
  }, [automatic, consent, status, activity, saving, liveActive, source.recordingId, source.complete, backend, attemptCount]);
  return <section aria-label="Conversation map" className="mt-8 border-t border-slate-200 pt-6">
    <h2 className="text-lg font-medium">AI map</h2>
    <p className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Turn finalized words into a map linked to their source. {source.complete ? 'The recording is complete.' : 'This is a partial transcript; unfinished words are excluded.'} {retention === 'local' ? 'The map saves in this browser; it is never published automatically.' : 'Generation does not save or publish it.'}</p>
    <label className="mt-4 block text-sm font-medium" htmlFor="map-inference-backend">AI provider</label>
    <select id="map-inference-backend" className="mt-2 min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm" value={backend} disabled={Boolean(activity) || saving} onChange={event => { setConsent(false); setStatus(null); setBackend(event.target.value); }}>
      <option value="gemini">Gemini · Google AI Studio</option>
      <option value="openrouter">OpenRouter</option>
    </select>
    {status?.model && <p className="mt-3 break-words text-sm text-slate-600">Model: {status.model} · Provider: {status.provider}</p>}
    {!activity && !status?.enabled && <p className="mt-3 text-sm leading-6 text-slate-600">Generation is waiting for provider setup and confirmed spending limits. Transcript download remains available.</p>}
    {status?.enabled && !status.available && <p className="mt-3 text-sm leading-6 text-slate-600">Shared generation capacity is unavailable. Check setup again before retrying; unresolved attempts may need owner review.</p>}
    {status?.audience === 'authenticated' && <p className="mt-3 text-sm text-slate-600">This generation test requires sign-in. <Link className="underline underline-offset-4" to="/private-files">Sign in from Private files</Link></p>}
    <label className="mt-4 flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1" checked={consent} disabled={Boolean(activity) || saving || !status?.enabled} onChange={event => { setConsent(event.target.checked); if (!event.target.checked) setAutomatic(false); }} />I have permission to send these finalized words to {backend === 'gemini' ? 'Google Gemini through Google AI Studio' : 'OpenRouter and the selected model provider'} to generate a map. Their processing policies apply.</label>
    <label className="mt-3 flex items-start gap-3 text-sm leading-6"><input type="checkbox" aria-label="Update map while I speak" className="mt-1" checked={automatic} disabled={!consent || !status?.available || attempts.current >= 6} onChange={event => setAutomatic(event.target.checked)} />Update map while I speak</label>
    <p className="mt-1 text-xs leading-5 text-slate-500">Updates use new confirmed words, at most once every 45 seconds. Automatic updates stop after six attempts per conversation. Shared limits apply. {attemptCount > 0 && `${attemptCount} attempts used.`}</p>
    {attemptCount >= 6 && <p role="status" className="mt-2 text-xs text-slate-600">Automatic updates have reached their limit. You can still request a map deliberately if shared capacity is available.</p>}
    <div className="mt-4 flex flex-wrap gap-3"><button className={`${button} border-slate-900 bg-slate-900 text-white`} disabled={!consent || !status?.available || Boolean(activity) || saving} onClick={() => void generate()}>{result ? 'Generate another map' : 'Generate conversation map'}</button><button className={button} disabled={Boolean(activity) || saving} onClick={() => void checkStatus()}>Retry generation setup</button></div>
    <PublicTaskStatus activity={activity} elapsed={elapsed} cancel={cancel} loadingLabel="Checking generation setup" />
    {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-900">{error}</p>}
    {result && <div className="mt-6">
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
  saving: PropTypes.bool.isRequired, onPrivateSave: PropTypes.func.isRequired, onGeneratingChange: PropTypes.func.isRequired, onMapChange: PropTypes.func, onMapStatusChange: PropTypes.func, liveActive: PropTypes.bool, recordingBusy: PropTypes.bool };
