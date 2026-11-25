import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import { Download, ExternalLink, FileText, FolderOpen, HardDrive, House, Layers, Mail, Settings, Users } from 'lucide-react';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import TooltipButton from '../components/TooltipButton.jsx';
import { useSitesRuntime } from '../contexts/SitesRuntimeContext';
import { configuredMapRoutes, getOrderedMapStatus, MAP_PROVIDERS } from '../services/cloud/openRouterClient.js';
import { recordSitesCostEntry } from '../services/cloud/sitesCostStore.js';
import { driveTimestampUrl, formatClock } from '../services/cloud/geminiNotesParser.js';
import { readTranscriptFile } from '../services/cloud/pdfTranscriptReader.js';
import { splitSourceIntoWindows } from '../services/cloud/longTranscriptPipeline.js';
import { runGlanceDetailPipeline } from '../services/cloud/glanceDetailPipeline.js';
import { stageGeneratedMap } from '../services/cloud/generatedMapHandoff.js';
import MapAuditPanel from '../components/audit/MapAuditPanel.jsx';
import { rememberThreadsArtifact } from '../services/threadsLibraryStore.js';

const navIcon = 'inline-flex size-12 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-700';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

function attachMeetingFields(bundle, parsed) {
  if (!bundle || !parsed) return bundle;
  return {
    ...bundle,
    ...(parsed.mediaRefs?.length ? { media_refs: parsed.mediaRefs } : {}),
    meeting_metadata: parsed.meetingMetadata,
  };
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const TIER_STYLES = {
  arc: 'bg-slate-900 text-white',
  theme: 'bg-indigo-100 text-indigo-900',
  topic: 'bg-amber-100 text-amber-900',
  idea: 'bg-emerald-100 text-emerald-900',
  chunk: 'bg-white text-slate-700 ring-1 ring-slate-200',
};

const TIER_LEVEL = { chunk: 1, idea: 2, topic: 3, theme: 4, arc: 5 };

function buildLiveCanvasBundle(completedBundle, liveNodes, parsed) {
  if (completedBundle?.graph_data?.length) return completedBundle;
  if (!liveNodes.length || !parsed) return null;
  return {
    conversation_title: parsed.title,
    utterances: parsed.initialBundle?.utterances || [],
    edges: [],
    graph_data: liveNodes.map((node, index) => ({
      id: `live-stream-${index}`,
      semantic_level: TIER_LEVEL[node.type] || 1,
      semantic_type: node.type || 'chunk',
      node_name: node.name,
      summary: 'Streaming live from model…',
      source_ref: { utterance_ids: [] },
    })),
  };
}

function MultiWindowPipelinePanel({ parsed, onBundleReady, onBusyChange }) {
  const runtime = useSitesRuntime();
  const navigate = useNavigate();
  const routes = useMemo(() => (runtime ? configuredMapRoutes(runtime) : []), [runtime]);
  const [readiness, setReadiness] = useState(null);
  const [consentRoutes, setConsentRoutes] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [streamStats, setStreamStats] = useState(null);
  const [liveNodes, setLiveNodes] = useState([]);
  const [eventLog, setEventLog] = useState([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [pipelineError, setPipelineError] = useState('');
  const [served, setServed] = useState('');
  const [completedBundle, setCompletedBundle] = useState(null);
  const [showLiveCanvas, setShowLiveCanvas] = useState(true);
  const [detail, setDetail] = useState('all');
  const liveCanvasBundle = useMemo(
    () => buildLiveCanvasBundle(completedBundle, liveNodes, parsed),
    [completedBundle, liveNodes, parsed],
  );
  const abortRef = useRef(null);
  const startedAtRef = useRef(0);
  const status = readiness?.routes === routes ? readiness.status : null;
  const statusError = readiness?.routes === routes ? readiness.error : '';
  const consent = consentRoutes === routes;

  const recipients = [...new Set(routes.map(({ backend }) => MAP_PROVIDERS[backend].recipient))].join(', ');
  const routeSummary = routes.map(({ backend, model }) => (model ? `${MAP_PROVIDERS[backend].name} (${model})` : MAP_PROVIDERS[backend].name)).join(' → ');

  useEffect(() => {
    if (!routes.length) return undefined;
    const controller = new AbortController();
    getOrderedMapStatus(controller.signal, routes)
      .then(status => { if (!controller.signal.aborted) setReadiness({ routes, status }); })
      .catch(() => { if (!controller.signal.aborted) setReadiness({ routes, error: 'Could not check provider readiness.' }); });
    return () => controller.abort();
  }, [routes]);

  useEffect(() => {
    onBusyChange?.(running);
    return () => onBusyChange?.(false);
  }, [running, onBusyChange]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function appendLog(text) {
    const stamp = formatElapsed(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)));
    setEventLog(prev => [...prev.slice(-49), { id: `${Date.now()}-${prev.length}`, stamp, text }]);
  }

  async function startPipeline() {
    if (!consent || !status?.available || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    startedAtRef.current = Date.now();
    setElapsedSec(0);
    setStreamStats(null);
    setLiveNodes([]);
    setEventLog([{ id: 'start', stamp: '0:00', text: 'Starting overview → detail pipeline…' }]);
    setRunning(true);
    setPipelineError('');
    setProgress({ phase: 'starting' });
    try {
      const result = await runGlanceDetailPipeline({
        detail,
        source: parsed.source,
        routes,
        guidance: runtime?.preferences?.guidance || '',
        title: parsed.title,
        meetingMetadata: parsed.meetingMetadata,
        mediaRefs: parsed.mediaRefs,
        signal: controller.signal,
        onProgress: event => {
          if (event.phase === 'log' && event.entry) {
            appendLog(event.entry.text);
            for (const line of event.entry.attempts || []) appendLog(`  ↳ ${line}`);
            return;
          }
          if (event.phase === 'stream' && event.streamEvent) {
            const se = event.streamEvent;
            if (se.type === 'stage') {
              if (se.stage === 'admitted') {
                setStreamStats({ stage: 'admitted', provider: se.provider, model: se.model, approxTokens: 0 });
                appendLog(`Admitted (${se.task || 'map'}) → ${se.provider || ''} ${se.model || ''}`.trim());
              } else if (se.stage === 'connected') {
                setStreamStats(prev => ({ ...prev, stage: 'streaming', provider: se.provider, model: se.model, ttftMs: se.ttftMs }));
                appendLog(`${se.provider} connected (first token ${(se.ttftMs / 1000).toFixed(1)}s) — streaming nodes…`);
              } else if (se.stage === 'validating') {
                setStreamStats(prev => ({ ...prev, stage: 'validating' }));
                appendLog(`Response received (${(se.elapsedMs / 1000).toFixed(1)}s) — validating hierarchy & turn ranges…`);
              } else if (se.stage === 'fallback') {
                appendLog(`${se.provider} returned HTTP ${se.status} — trying ${se.nextModel}…`);
              }
            } else if (se.type === 'token_progress') {
              setStreamStats(prev => ({ ...prev, stage: 'streaming', provider: se.provider, model: se.model, chars: se.chars, approxTokens: se.approxTokens, elapsedMs: se.elapsedMs }));
            } else if (se.type === 'node_discovered') {
              setLiveNodes(prev => {
                const key = `${se.semantic_type}|${se.node_name}`;
                if (prev.some(item => item.key === key)) return prev;
                return [...prev.slice(-49), { key, type: se.semantic_type, name: se.node_name }];
              });
            }
            return;
          }

          setProgress(event);
          if (event.phase === 'skeleton') {
            const count = event.partialBundle?.graph_data?.length || 0;
            appendLog(`✓ Overview ready (${count} skeleton nodes${event.model ? ` via ${event.model}` : ''}).`);
          } else if (event.phase === 'detail') {
            const label = (event.topics || []).slice(0, 2).join(', ');
            appendLog(`Detailing group ${(event.segmentIndex ?? 0) + 1}/${event.totalSegments}: ${label}…`);
          } else if (event.phase === 'done') {
            const count = event.partialBundle?.graph_data?.length || 0;
            appendLog(`✓ Map complete (${count} validated nodes).`);
            setStreamStats(null);
          }
          if (event.partialBundle) {
            setCompletedBundle(event.partialBundle);
            onBundleReady(event.partialBundle);
          }
        },
      });
      setCompletedBundle(result.bundle);
      onBundleReady(result.bundle);
      if (result.backend && result.model) setServed(`${MAP_PROVIDERS[result.backend].name} · ${result.model}`);
    } catch (cause) {
      setProgress(current => ({ ...current, phase: 'stopped' }));
      setStreamStats(null);
      if (cause?.name === 'AbortError') {
        appendLog('Cancelled by user.');
        setPipelineError('Pipeline cancelled. The overview and any detailed topics are preserved in your partial map.');
      } else {
        appendLog(`Stopped: ${cause?.message || 'error'}`);
        setPipelineError(cause?.message || 'Multi-tier pipeline did not finish.');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const percent = !progress ? 0 : progress.phase === 'done' ? 100
    : progress.totalSegments ? 10 + Math.round(90 * (progress.completedSegments || 0) / progress.totalSegments)
      : ['skeleton', 'detail'].includes(progress.phase) ? 10 : 0;
  const progressText = !progress ? '' : {
    starting: 'Starting…',
    glance: 'Reading the whole conversation for its overview: topics, themes and arcs…',
    skeleton: `Overview ready${progress.model ? ` (${progress.model})` : ''}. Preparing detail…`,
    detail: progress.totalSegments
      ? `Detailing topic group ${(progress.segmentIndex ?? 0) + 1} of ${progress.totalSegments}: ${(progress.topics || []).slice(0, 3).join(', ')}${(progress.topics || []).length > 3 ? '…' : ''}`
      : 'Detailing topics…',
    done: `Map complete${served ? ` via ${served}` : ''}.`,
    stopped: progress.totalSegments
      ? `Stopped after ${progress.completedSegments || 0} of ${progress.totalSegments} topic groups. The overview is kept.`
      : 'Stopped before the overview finished.',
  }[progress.phase] || '';

  return (
    <section aria-label="Multi-tier abstraction pipeline" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Layers size={13} aria-hidden="true" /> Overview, then detail
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">Build 5-tier conversation map</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            This transcript spans {formatClock(parsed.durationMs)} ({parsed.wordCount.toLocaleString()} words). One overview call reads the whole conversation and names its arcs, themes and topics, including subjects it returns to. Detail calls then fill in ideas and chunks topic by topic, each linked to exact turns.
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
        <p className="font-medium">{routeSummary || (runtime?.credentialsReady === false ? 'Loading saved providers…' : 'No provider configured')}</p>
        <Link className="text-xs underline underline-offset-4" to="/settings/runtime">Manage provider order, models, and keys</Link>
      </div>

      {statusError && <p role="alert" className="text-sm text-rose-800">{statusError}</p>}
      {status && !status.enabled && (
        <p className="text-sm text-amber-800">
          Add a personal API key and select a model in <Link className="underline" to="/settings/runtime">Settings → Providers</Link> to run the pipeline.
        </p>
      )}

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-700">Detail</span>
        <select className="rounded-md border border-slate-300 bg-white px-2 py-1" value={detail} disabled={running}
          onChange={event => setDetail(event.target.value)}>
          <option value="all">All topics</option>
          <option value="core">Core topics only</option>
          <option value="none">Overview only</option>
        </select>
      </label>

      <label className="flex items-start gap-3 text-sm leading-6">
        <input type="checkbox" className="mt-1" checked={consent} disabled={running || !status?.enabled}
          onChange={event => setConsentRoutes(event.target.checked ? routes : null)} />
        I have permission to send these {parsed.turns.length} transcript turns to {recipients}: the whole transcript once for the overview, then the turns of each topic group for detail.
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={!consent || !status?.available || running} onClick={() => void startPipeline()}>
          {running ? `Mapping… (${formatElapsed(elapsedSec)})` : completedBundle ? 'Regenerate map' : 'Build map'}
        </button>
        {running && (
          <button type="button" className={button} onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        )}
        {completedBundle && (
          <button type="button" className={button} onClick={() => navigate('/view', { state: { generatedMapId: stageGeneratedMap(completedBundle), remember: false } })}>
            {running ? 'Explore overview' : 'Explore map'}
          </button>
        )}
      </div>

      {progress && (
        <div role="status" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-slate-700">
            <span className="flex items-center gap-2">
              {running && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />}
              <span>{progressText}</span>
            </span>
            <span className="tabular-nums text-slate-600">
              {running ? `${formatElapsed(elapsedSec)} · ` : ''}{percent}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full bg-slate-900 transition-all ${running && percent === 0 ? 'w-1/6 animate-pulse' : ''}`}
              style={running && percent === 0 ? undefined : { width: `${percent}%` }}
            />
          </div>

          {streamStats && running && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200">
              <span>
                <span className="font-medium text-slate-900">{streamStats.provider || 'Provider'}</span>
                {streamStats.model ? ` · ${streamStats.model}` : ''}
                {streamStats.ttftMs != null ? ` · First token ${(streamStats.ttftMs / 1000).toFixed(1)}s` : ''}
              </span>
              <span className="tabular-nums text-slate-600">
                {streamStats.stage === 'validating'
                  ? 'Validating JSON & turn ranges…'
                  : streamStats.approxTokens > 0
                    ? `~${streamStats.approxTokens.toLocaleString()} tokens streaming…`
                    : 'Waiting for first token…'}
              </span>
            </div>
          )}

          {liveCanvasBundle && (
            <div className="border-t border-slate-200 pt-2">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Live interactive canvas ({liveCanvasBundle.graph_data.length} nodes{running ? ' · updating live' : ''})
                </p>
                <div className="flex items-center gap-2">
                  <button type="button" className="text-xs font-medium text-slate-700 underline underline-offset-2" onClick={() => setShowLiveCanvas(v => !v)}>
                    {showLiveCanvas ? 'Hide canvas' : 'Show canvas'}
                  </button>
                  {completedBundle && (
                    <button type="button" className="text-xs font-medium text-slate-900 underline underline-offset-2"
                      onClick={() => navigate('/view', { state: { generatedMapId: stageGeneratedMap(completedBundle), remember: false } })}>
                      Full-screen viewer ↗
                    </button>
                  )}
                </div>
              </div>
              {showLiveCanvas && (
                <div className="relative flex h-[480px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <LiveConversationGraph bundle={liveCanvasBundle} recording={running} />
                </div>
              )}
            </div>
          )}

          {liveNodes.length > 0 && (
            <div className="border-t border-slate-200 pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Live nodes emerging ({liveNodes.length})
              </p>
              <div className="mt-1.5 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                {liveNodes.map(node => (
                  <span key={node.key} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TIER_STYLES[node.type] || TIER_STYLES.chunk}`}>
                    <span className="uppercase opacity-75">{node.type}</span>
                    <span>{node.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {eventLog.length > 0 && (
            <details open={running} className="border-t border-slate-200 pt-2 text-xs">
              <summary className="cursor-pointer font-medium text-slate-600">Live event log ({eventLog.length})</summary>
              <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-600">
                {eventLog.map(item => (
                  <li key={item.id} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-slate-400">{item.stamp}</span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {pipelineError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{pipelineError}</p>}

      {completedBundle && !running && (
        <MapAuditPanel source={parsed.source} bundle={completedBundle} routes={routes}
          onBundleChange={bundle => { setCompletedBundle(bundle); onBundleReady(bundle); }} />
      )}
    </section>
  );
}
MultiWindowPipelinePanel.propTypes = {
  parsed: PropTypes.object.isRequired,
  onBundleReady: PropTypes.func.isRequired,
  onBusyChange: PropTypes.func,
};

export default function SitesTranscriptImport() {
  const navigate = useNavigate();
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [parsed, setParsed] = useState(null);
  const [generatedBundle, setGeneratedBundle] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [savedRecordId, setSavedRecordId] = useState('');

  const windows = useMemo(() => (parsed ? splitSourceIntoWindows(parsed.source) : []), [parsed]);
  const activeBundle = useMemo(
    () => (parsed ? attachMeetingFields(generatedBundle || parsed.initialBundle, parsed) : null),
    [parsed, generatedBundle],
  );

  useEffect(() => {
    if (!activeBundle) { setDownloadUrl(''); return undefined; }
    const blob = new Blob([JSON.stringify(activeBundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [activeBundle]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setError('');
    setNotice('');
    setGeneratedBundle(null);
    setSavedRecordId('');
    try {
      const parseStarted = Date.now();
      const result = await readTranscriptFile(file);
      recordSitesCostEntry({
        provider: 'browser', model: /\.pdf$/i.test(file.name) ? 'pdfjs-local' : 'text-local',
        kind: 'parse', durationMs: Date.now() - parseStarted, outcome: 'ok', nodes: result.turns?.length ?? null,
      });
      setParsed(result);
    } catch (cause) {
      setParsed(null);
      setError(cause?.message || 'Could not parse this transcript file.');
    } finally {
      setParsing(false);
    }
  }

  async function saveToBrowser() {
    if (!activeBundle || !parsed) return;
    setError('');
    setNotice('');
    try {
      const record = await rememberThreadsArtifact(activeBundle, { sourceName: parsed.initialFilename });
      setSavedRecordId(record.id);
      setNotice('Saved to this browser’s library under Browse → On this device.');
    } catch (cause) {
      setError(cause?.message || 'Could not save to this browser.');
    }
  }

  const transcriptKiB = parsed ? Math.ceil(new TextEncoder().encode(parsed.transcript.full_transcript).byteLength / 1024) : 0;

  return (
    <main className="min-h-dvh bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-32 pt-8 font-sans text-slate-800 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <nav aria-label="Transcript import navigation" className="flex items-center justify-between gap-4">
          <TooltipButton as={Link} to="/" compact align="start" aria-label="Home" tooltip="Home"
            className="inline-flex size-16 items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-700">
            <House size={30} aria-hidden="true" />
          </TooltipButton>
          <div className="flex items-center gap-3">
            <TooltipButton as={Link} to="/browse" compact align="end" aria-label="Browse library" tooltip="Browse library" className={navIcon}>
              <FolderOpen size={23} aria-hidden="true" />
            </TooltipButton>
            <TooltipButton as={Link} to="/settings/runtime" compact align="end" aria-label="Providers" tooltip="Providers" className={navIcon}>
              <Settings size={23} aria-hidden="true" />
            </TooltipButton>
          </div>
        </nav>

        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-slate-900">Import transcript</h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-6 text-slate-600">
            Import a Google Meet notes PDF or a plain transcript.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <label htmlFor="transcript-file-input" className="block text-sm font-medium text-slate-900">
            Choose a transcript file (.pdf, .txt, .md, .vtt)
          </label>
          <p className="mt-1 text-xs text-slate-500">
            The file is read on this device.
          </p>
          <input
            id="transcript-file-input"
            type="file"
            accept=".pdf,.txt,.md,.vtt,application/pdf,text/plain"
            disabled={parsing || generating}
            onChange={event => void handleFileChange(event)}
            className="mt-3 block w-full rounded-lg border border-slate-300 p-2.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200"
          />
          {parsing && <p role="status" className="mt-3 text-sm text-slate-600">Reading and separating notes and raw transcript locally…</p>}
          {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
        </section>

        {parsed && (
          <>
            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                  <FileText size={12} aria-hidden="true" />
                  {parsed.sourceFormat === 'google_meet_gemini_pdf' ? 'Google Meet · Notes by Gemini PDF' : 'Transcript'}
                </span>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">{parsed.title}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {formatClock(parsed.durationMs)} · {parsed.turns.length} turns · {parsed.wordCount.toLocaleString()} words · {transcriptKiB} KiB raw text
                </p>
              </div>

              <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <Users size={13} aria-hidden="true" /> Speakers ({parsed.speakers.length})
                  </p>
                  <p className="mt-1 text-sm text-slate-800">{parsed.speakers.join(', ')}</p>
                </div>

                {parsed.invitedEmails.length > 0 && (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <Mail size={13} aria-hidden="true" /> Meet attendees (default share recipients)
                    </p>
                    <p className="mt-1 break-all text-sm text-slate-800">{parsed.invitedEmails.join(', ')}</p>
                  </div>
                )}
              </div>

              {parsed.recordingUrl && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm">
                  <span className="text-slate-700">Linked Google Drive recording detected — every node &amp; passage jumps straight to that moment.</span>
                  <a href={parsed.recordingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-slate-900 underline underline-offset-4">
                    Open recording <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {downloadUrl && (
                  <a className={primary} href={downloadUrl} download={parsed.initialFilename}>
                    <Download size={16} aria-hidden="true" />
                    {generatedBundle ? 'Download mapped .threads' : 'Download initial .threads'}
                  </a>
                )}
                <button type="button" className={button} onClick={() => void saveToBrowser()}>
                  <HardDrive size={16} aria-hidden="true" /> Save to this browser
                </button>
                {savedRecordId && (
                  <button type="button" className={button} onClick={() => navigate(`/view/${encodeURIComponent(savedRecordId)}`)}>
                    Open in viewer
                  </button>
                )}
              </div>

              {parsed.referenceNotes && (
                <details className="rounded-lg border border-slate-200 p-3.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-800">
                    Gemini notes extracted as reference baseline (not used as input to our map)
                  </summary>
                  <div className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                    {parsed.referenceNotes.summary && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gemini Summary</h3>
                        <p className="mt-1 whitespace-pre-line">{parsed.referenceNotes.summary}</p>
                      </div>
                    )}
                    {parsed.referenceNotes.next_steps && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gemini Next steps</h3>
                        <p className="mt-1 whitespace-pre-line">{parsed.referenceNotes.next_steps}</p>
                      </div>
                    )}
                    {parsed.referenceNotes.quick_notes && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gemini Quick notes</h3>
                        <p className="mt-1 whitespace-pre-line">{parsed.referenceNotes.quick_notes}</p>
                      </div>
                    )}
                  </div>
                </details>
              )}

              <details className="rounded-lg border border-slate-200 p-3.5">
                <summary className="cursor-pointer text-sm font-medium text-slate-800">
                  Preview raw transcript ({parsed.turns.length} turns)
                </summary>
                <ol className="mt-3 max-h-80 space-y-2.5 overflow-y-auto pr-1 text-sm">
                  {parsed.turns.slice(0, 40).map((turn, index) => {
                    const jumpUrl = driveTimestampUrl(parsed.recordingUrl, turn.startMs);
                    return (
                      <li key={index} className="rounded-md bg-slate-50 p-2.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-semibold text-slate-800">{turn.speaker}</span>
                          {jumpUrl ? (
                            <a href={jumpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-slate-800">
                              {formatClock(turn.startMs)} <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          ) : (
                            <span>{formatClock(turn.startMs)}</span>
                          )}
                        </div>
                        <p className="mt-1 leading-relaxed text-slate-700">{turn.text}</p>
                      </li>
                    );
                  })}
                  {parsed.turns.length > 40 && (
                    <li className="text-xs text-slate-500">Showing first 40 of {parsed.turns.length} turns.</li>
                  )}
                </ol>
              </details>
            </section>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              {windows.length > 1 ? (
                <MultiWindowPipelinePanel
                  key={parsed.source.recordingId}
                  parsed={parsed}
                  onBundleReady={setGeneratedBundle}
                  onBusyChange={setGenerating}
                />
              ) : (
                <RecordingConversationMap
                  localOnly
                  retention="local"
                  source={parsed.source}
                  savedBundle={activeBundle}
                  privateEnabled={false}
                  saving={false}
                  onPrivateSave={() => {}}
                  onGeneratingChange={setGenerating}
                  onMapChange={bundle => setGeneratedBundle(attachMeetingFields(bundle, parsed))}
                />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
