import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, FileText, HardDrive, Mail, Users } from 'lucide-react';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { driveTimestampUrl, formatClock } from '../services/cloud/geminiNotesParser.js';
import { readTranscriptFile } from '../services/cloud/pdfTranscriptReader.js';
import { rememberThreadsArtifact } from '../services/threadsLibraryStore.js';

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

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

  useEffect(() => {
    if (!parsed) { setDownloadUrl(''); return undefined; }
    const bundle = generatedBundle ? { ...generatedBundle, meeting_metadata: parsed.meetingMetadata } : parsed.initialBundle;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [parsed, generatedBundle]);

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
    if (!parsed) return;
    setError('');
    setNotice('');
    try {
      const bundle = generatedBundle ? { ...generatedBundle, meeting_metadata: parsed.meetingMetadata } : parsed.initialBundle;
      const record = await rememberThreadsArtifact(bundle, { sourceName: parsed.initialFilename });
      setSavedRecordId(record.id);
      setNotice('Saved to this browser’s library under Browse → On this device.');
    } catch (cause) {
      setError(cause?.message || 'Could not save to this browser.');
    }
  }

  const activeBundle = parsed
    ? (generatedBundle ? { ...generatedBundle, meeting_metadata: parsed.meetingMetadata } : parsed.initialBundle)
    : null;
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
              <div className="flex flex-wrap items-start justify-between gap-3">
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
                  <span className="text-slate-700">Linked Google Drive recording detected — timestamps below jump straight to that moment.</span>
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
              <RecordingConversationMap
                localOnly
                retention="local"
                source={parsed.source}
                savedBundle={activeBundle}
                privateEnabled={false}
                saving={false}
                onPrivateSave={() => {}}
                onGeneratingChange={setGenerating}
                onMapChange={bundle => setGeneratedBundle(bundle)}
              />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
