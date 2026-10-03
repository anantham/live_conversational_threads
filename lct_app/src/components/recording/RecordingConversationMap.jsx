import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { getRecordingMapStatus, generateRecordingMap } from '../../services/cloud/openRouterClient.js';
import { useCloudTask } from '../../hooks/useCloudTask.js';
import PublicTaskStatus from '../PublicTaskStatus.jsx';
import PrivateRetentionNotice from '../PrivateRetentionNotice.jsx';
import { stageGeneratedMap } from '../../services/cloud/generatedMapHandoff.js';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const interrupted = 'Waiting stopped. The attempt may still be running or counted; stopping this view does not confirm billing stopped. Keep your transcript and check setup before a deliberate retry.';

export default function RecordingConversationMap({ source, privateEnabled, saving, onPrivateSave, onGeneratingChange }) {
  const [status, setStatus] = useState(null), [consent, setConsent] = useState(false);
  const [result, setResult] = useState(null), [error, setError] = useState(''), [url, setURL] = useState('');
  const { run, cancel, activity, elapsed } = useCloudTask('recording-map');
  const alive = useRef(true), currentSource = useRef(source);
  currentSource.current = source;
  const navigate = useNavigate();
  const checkStatus = useCallback(async () => {
    setError('');
    const response = await run('load', getRecordingMapStatus);
    if (!alive.current) return;
    if (response.data) setStatus(response.data);
    else { setStatus(null); setError(response.outcome === 'cancelled' || response.outcome === 'timeout'
      ? 'Generation setup stopped or timed out. Keep the transcript and retry setup.' : 'Generation setup is unavailable. Recording and local downloads remain available. Retry generation setup.'); }
  }, [run]);
  useEffect(() => {
    alive.current = true; setResult(null); setConsent(false); setStatus(null); void checkStatus();
    return () => { alive.current = false; cancel(); };
  }, [source, checkStatus, cancel]);
  useEffect(() => { onGeneratingChange(activity === 'generate'); return () => onGeneratingChange(false); }, [activity, onGeneratingChange]);
  useEffect(() => {
    if (!result) { setURL(''); return; }
    const next = URL.createObjectURL(result.file); setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [result]);
  async function generate() {
    if (!consent || !status?.enabled || !status.available || activity || saving) return;
    const requestedSource = source;
    setError('');
    const response = await run('generate', signal => generateRecordingMap(requestedSource, signal));
    if (!alive.current || currentSource.current !== requestedSource) return;
    if (response.data) setResult(response.data);
    else setError(response.outcome === 'cancelled' || response.outcome === 'timeout' ? interrupted : response.error.message);
  }
  return <section aria-label="Conversation map" className="mt-8 border-t border-slate-200 pt-6">
    <h2 className="text-lg font-medium">Map this conversation</h2>
    <p className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Turn finalized words into a map linked to their source. {source.complete ? 'The recording is complete.' : 'This is a partial transcript; unfinished words are excluded.'} Generation does not save or publish it.</p>
    {status?.model && <p className="mt-3 break-words text-sm text-slate-600">Model: {status.model} · Provider: {status.provider}</p>}
    {!activity && !status?.enabled && <p className="mt-3 text-sm leading-6 text-slate-600">Generation is waiting for provider setup and confirmed spending limits. Transcript download remains available.</p>}
    {status?.enabled && !status.available && <p className="mt-3 text-sm leading-6 text-slate-600">Shared generation capacity is unavailable. Check setup again before retrying; unresolved attempts may need owner review.</p>}
    {status?.audience === 'authenticated' && <p className="mt-3 text-sm text-slate-600">This generation test requires sign-in. <Link className="underline underline-offset-4" to="/private-files">Sign in from Private files</Link></p>}
    <label className="mt-4 flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1" checked={consent} disabled={Boolean(activity) || saving || !status?.enabled} onChange={event => setConsent(event.target.checked)} />I have permission to send these finalized words to OpenRouter and the selected model provider to generate a map. Their processing policies apply.</label>
    <div className="mt-4 flex flex-wrap gap-3"><button className={`${button} border-slate-900 bg-slate-900 text-white`} disabled={!consent || !status?.available || Boolean(activity) || saving} onClick={() => void generate()}>{result ? 'Generate another map' : 'Generate conversation map'}</button><button className={button} disabled={Boolean(activity) || saving} onClick={() => void checkStatus()}>Retry generation setup</button></div>
    <PublicTaskStatus activity={activity} elapsed={elapsed} cancel={cancel} loadingLabel="Checking generation setup" />
    {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-900">{error}</p>}
    {result && <div className="mt-6">
      <p role="status" className="text-sm leading-6">Your map is ready in this tab. Download audio, transcript and map before leaving the recording page.</p>
      <PrivateRetentionNotice id="map-private-retention" />
      <div className="mt-4 flex flex-wrap gap-3"><button className={button} disabled={Boolean(activity) || saving} onClick={() => navigate('/view', { state: { generatedMapId: stageGeneratedMap(result.bundle), remember: false } })}>Explore map</button>{url && <a className={button} href={url} download={result.filename}>Download map</a>}<button className={button} aria-describedby="map-private-retention" disabled={!privateEnabled || Boolean(activity) || saving} onClick={() => onPrivateSave(result.file, 'Map')}>Save map privately</button></div>
      {!privateEnabled && <p className="mt-3 text-sm text-slate-600">Private saving needs sign-in and enabled personal storage. You can download this map now.</p>}
      <p className="mt-3 text-sm leading-6 text-slate-600">To share a public copy, download the map and use <Link className="underline underline-offset-4" to="/public">Public conversations</Link>. That step has separate confirmation and file limits.</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Copy map data if download is unavailable</summary><label htmlFor="recording-map-json" className="mt-3 block">Conversation map JSON</label><textarea id="recording-map-json" readOnly value={result.json} rows={5} className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm" /></details>
    </div>}
  </section>;
}

RecordingConversationMap.propTypes = { source: PropTypes.object.isRequired, privateEnabled: PropTypes.bool,
  saving: PropTypes.bool.isRequired, onPrivateSave: PropTypes.func.isRequired, onGeneratingChange: PropTypes.func.isRequired };
