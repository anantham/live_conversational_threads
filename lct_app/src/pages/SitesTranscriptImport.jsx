import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, FileText, HardDrive, Layers, Mail, Users } from 'lucide-react';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { useSitesRuntime } from '../contexts/SitesRuntimeContext';
import { configuredMapRoutes, getOrderedMapStatus, MAP_PROVIDERS } from '../services/cloud/openRouterClient.js';
import { driveTimestampUrl, formatClock } from '../services/cloud/geminiNotesParser.js';
import { readTranscriptFile } from '../services/cloud/pdfTranscriptReader.js';
import { runLongTranscriptPipeline, splitSourceIntoWindows } from '../services/cloud/longTranscriptPipeline.js';
import { stageGeneratedMap } from '../services/cloud/generatedMapHandoff.js';
import { rememberThreadsArtifact } from '../services/threadsLibraryStore.js';

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

function MultiWindowPipelinePanel({ parsed, windows, onBundleReady, onBusyChange }) {
  const runtime = useSitesRuntime();
  const navigate = useNavigate();
  const routes = useMemo(() => (runtime ? configuredMapRoutes(runtime) : []), [runtime]);
  const [readiness, setReadiness] = useState(null);
  const [consentRoutes, setConsentRoutes] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [pipelineError, setPipelineError] = useState('');
  const [served, setServed] = useState('');
  const [completedBundle, setCompletedBundle] = useState(null);
  const abortRef = useRef(null);
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

  useEffect(() => () => abortRef.current?.abort(), []);

  async function startPipeline() {
    if (!consent || !status?.available || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPipelineError('');
    setProgress({ phase: 'starting', windowIndex: 0, totalWindows: windows.length, completedWindows: 0 });
    try {
      const result = await runLongTranscriptPipeline({
        source: parsed.source,
        routes,
        guidance: runtime?.preferences?.guidance || '',
        title: parsed.title,
        meetingMetadata: parsed.meetingMetadata,
        mediaRefs: parsed.mediaRefs,
        signal: controller.signal,
        onProgress: event => {
          setProgress(event);
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
      if (cause?.name === 'AbortError') {
        setPipelineError('Pipeline cancelled. Any completed windows are preserved in your partial map.');
      } else {
        setPipelineError(cause?.message || 'Multi-tier pipeline did not finish.');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  return (
    <section aria-label="Multi-tier abstraction pipeline" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Layers size={13} aria-hidden="true" /> Windowed multi-tier pipeline
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">Build 5-tier conversation map ({windows.length} windows)</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            This transcript spans {formatClock(parsed.durationMs)} ({parsed.wordCount.toLocaleString()} words). To avoid output truncation and preserve fine-grained evidence, we process it in {windows.length} chronological windows (~15 min / ~2,800 words each) and assemble all chunks, ideas, topics, themes, arcs, and threads onto the single canonical transcript.
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

      <label className="flex items-start gap-3 text-sm leading-6">
        <input type="checkbox" className="mt-1" checked={consent} disabled={running || !status?.enabled}
          onChange={event => setConsentRoutes(event.target.checked ? routes : null)} />
        I have permission to send these {parsed.turns.length} transcript turns to {recipients} across {windows.length} windows to build a conversation map.
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={!consent || !status?.available || running} onClick={() => void startPipeline()}>
          {running ? `Mapping window ${(progress?.windowIndex ?? 0) + 1} of ${windows.length}…` : completedBundle ? 'Regenerate full map' : `Run ${windows.length}-window pipeline`}
        </button>
        {running && (
          <button type="button" className={button} onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        )}
        {completedBundle && !running && (
          <button type="button" className={button} onClick={() => navigate('/view', { state: { generatedMapId: stageGeneratedMap(completedBundle), remember: false } })}>
            Explore map
          </button>
        )}
      </div>

      {progress && (
        <div role="status" className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-700">
            <span>
              {progress.phase === 'waiting' && `Pacing before window ${progress.windowIndex + 1} of ${progress.totalWindows} (${formatClock(progress.startMs)}–${formatClock(progress.endMs)})…`}
              {progress.phase === 'generating' && `Generating multi-tier nodes for window ${progress.windowIndex + 1} of ${progress.totalWindows} (${formatClock(progress.startMs)}–${formatClock(progress.endMs)})…`}
              {progress.phase === 'window_complete' && `Completed ${progress.completedWindows} of ${progress.totalWindows} windows.`}
              {progress.phase === 'done' && `Completed all ${progress.totalWindows} windows${served ? ` via ${served}` : ''}.`}
              {progress.phase === 'starting' && 'Starting multi-tier pipeline…'}
              {progress.phase === 'stopped' && `Stopped after ${progress.completedWindows} of ${progress.totalWindows} windows.`}
            </span>
            <span>{Math.round(((progress.completedWindows || 0) / progress.totalWindows) * 100)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-slate-900 transition-all" style={{ width: `${Math.round(((progress.completedWindows || 0) / progress.totalWindows) * 100)}%` }} />
          </div>
        </div>
      )}

      {pipelineError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{pipelineError}</p>}
    </section>
  );
}
MultiWindowPipelinePanel.propTypes = {
  parsed: PropTypes.object.isRequired,
  windows: PropTypes.array.isRequired,
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
      const result = await readTranscriptFile(file);
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
        <nav className="flex flex-wrap items-center justify-between gap-4 text-sm">
          <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-slate-600 underline-offset-4 hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Home
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/browse" className="inline-flex min-h-11 items-center text-slate-600 underline-offset-4 hover:underline">Browse library</Link>
            <Link to="/settings/runtime" className="inline-flex min-h-11 items-center text-slate-600 underline-offset-4 hover:underline">Providers</Link>
          </div>
        </nav>

        <header className="border-b border-slate-200 pb-6">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-500">Transcript-first pipeline</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-slate-900">Import transcript</h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-6 text-slate-600">
            Import a Google Meet “Notes by Gemini” PDF or a plain transcript file. Your file is parsed locally in this browser into an initial <code>.threads</code> file — skipping audio transcription — so you can run your own Intelligence providers on the raw transcript.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <label htmlFor="transcript-file-input" className="block text-sm font-medium text-slate-900">
            Choose a transcript file (.pdf, .txt, .md, .vtt)
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Nothing is uploaded while parsing. Gemini notes are preserved separately as a reference baseline, and the raw transcript is extracted for our own analysis.
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
                  windows={windows}
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
