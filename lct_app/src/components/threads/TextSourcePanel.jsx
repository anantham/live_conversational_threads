import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { X } from "lucide-react";
import SourceSpeakerEditor from "./SourceSpeakerEditor";
import { validYouTubeRef } from "../../services/youtubeMedia";
import { buildMediaSeekUrl, mediaOffsetLabel, selectMediaRef } from "../../services/mediaSeek";
import { buildSpeakerDisplayNames, speakerDisplayName, transcriptSpeakerLabels } from "../../services/speakerDisplay";

function tierSummary(bundle) {
  const nodes = Array.isArray(bundle?.graph_data) ? bundle.graph_data : [];
  const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const node of nodes) {
    if (counts[node?.semantic_level] != null) counts[node.semantic_level]++;
  }
  const labels = [[5, "arcs"], [4, "themes"], [3, "topics"], [2, "ideas"], [1, "chunks"]];
  return labels.filter(([lvl]) => counts[lvl] > 0).map(([lvl, label]) => `${counts[lvl]} ${label}`).join(" · ");
}

export default function TextSourcePanel({ bundle, selection = null, compact = false, onClose, onRenameSpeaker, namesStayInView = false, sectionMode, onSectionChange }) {
  const transcript = typeof bundle.full_transcript === "string" ? bundle.full_transcript : "";
  const utterances = Array.isArray(bundle.utterances) ? bundle.utterances : [];
  const referenceNotes = bundle.meeting_metadata?.reference_notes || null;
  const hasGeminiNotes = Boolean(referenceNotes && (referenceNotes.summary || referenceNotes.quick_notes || referenceNotes.next_steps));
  const driveMediaRef = useMemo(() => {
    const selected = selectMediaRef(bundle.media_refs);
    return selected?.provider === "google_drive" ? selected : null;
  }, [bundle.media_refs]);
  const speakerNames = useMemo(() => buildSpeakerDisplayNames(bundle), [bundle]);
  const displayLabels = useMemo(() => transcriptSpeakerLabels(transcript, speakerNames), [transcript, speakerNames]);
  const unsupportedRecording = (bundle.media_refs || []).some(ref => ref?.provider === "youtube" && !validYouTubeRef(ref));
  const [localMode, setLocalMode] = useState(() => selection?.kind === "utterance" || !transcript ? "utterances" : "transcript");
  const mode = !transcript && localMode !== "gemini" ? "utterances" : sectionMode || localMode;
  const setMode = (next) => { if (onSectionChange) onSectionChange(next); else setLocalMode(next); };
  const selectedRef = useRef(null);
  useEffect(() => {
    if (sectionMode) return;
    if (selection?.kind === "utterance") setLocalMode("utterances");
    else if (selection?.kind === "transcript") setLocalMode("transcript");
  }, [selection, sectionMode]);
  const range = useMemo(() => {
    if (selection?.kind !== "transcript") return null;
    const { start, end } = selection;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > transcript.length) return null;
    return { start, end };
  }, [selection, transcript]);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "center" });
  }, [mode, range, selection?.utteranceId]);

  const renderRaw = (start, end) => {
    if (!range || end <= range.start || start >= range.end) return transcript.slice(start, end);
    const markedStart = Math.max(start, range.start);
    const markedEnd = Math.min(end, range.end);
    return <>{transcript.slice(start, markedStart)}<mark ref={selectedRef} className="bg-amber-200">{transcript.slice(markedStart, markedEnd)}</mark>{transcript.slice(markedEnd, end)}</>;
  };
  const renderedTranscript = [];
  let cursor = 0;
  displayLabels.forEach(({ start, end, speakerId, text }, index) => {
    if (cursor < start) renderedTranscript.push(<span key={`raw-${index}`}>{renderRaw(cursor, start)}</span>);
    // A selection that crosses the original label displays its raw bytes so
    // the selected text still agrees with the original source offsets.
    const overlapsSelection = range && start < range.end && end > range.start;
    renderedTranscript.push(overlapsSelection
      ? <span key={`label-${index}`}>{renderRaw(start, end)}</span>
      : <span key={`label-${index}`} data-speaker-id={speakerId}>{text}</span>);
    cursor = end;
  });
  renderedTranscript.push(<span key="raw-last">{renderRaw(cursor, transcript.length)}</span>);

  return <aside aria-label="Text source" style={compact ? { maxHeight: "min(60dvh, 60%)" } : undefined} className={`lct-source-panel flex min-h-0 shrink-0 flex-col border-slate-200 bg-white p-3 text-xs text-slate-700 ${compact ? "overflow-y-auto border-b" : "overflow-hidden w-[360px] max-w-[38vw] border-r"}`}>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h2 className="font-medium text-slate-800">Original source text</h2>
      <button type="button" onClick={onClose} aria-label="Close source" title="Close source" className="inline-flex size-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-slate-700"><X size={16} aria-hidden="true" /></button>
    </div>
    {unsupportedRecording && <p role="status" className="mb-2 shrink-0 text-amber-800">YouTube source unavailable. The recording link or timing information could not be verified. You can still read the transcript below.</p>}
    {((transcript && utterances.length > 0) || hasGeminiNotes) && <div role="group" aria-label="Text source section" className="mb-2 flex flex-wrap gap-1.5">
      {transcript && <button type="button" aria-pressed={mode === "transcript"} onClick={() => setMode("transcript")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Full transcript</button>}
      {utterances.length > 0 && <button type="button" aria-pressed={mode === "utterances"} onClick={() => setMode("utterances")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Passages</button>}
      {hasGeminiNotes && <button type="button" aria-pressed={mode === "gemini"} onClick={() => setMode("gemini")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Compare Gemini</button>}
    </div>}
    {onRenameSpeaker && mode !== "gemini" && <div className="max-h-[45dvh] shrink-0 overflow-y-auto"><SourceSpeakerEditor bundle={bundle} onRenameSpeaker={onRenameSpeaker} namesStayInView={namesStayInView} /></div>}
    <div data-viewer-scroll="text-source" aria-label="Original source passages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-100 bg-stone-50 p-2 leading-5">
      {mode === "transcript" && transcript && <pre className="whitespace-pre-wrap break-words font-sans">{renderedTranscript}</pre>}
      {mode === "utterances" && utterances.map((row) => {
        const selected = selection?.kind === "utterance" && String(row.id) === String(selection.utteranceId);
        const offset = mediaOffsetLabel(row.timestamp_start);
        const driveUrl = driveMediaRef ? buildMediaSeekUrl(driveMediaRef, row.timestamp_start) : null;
        return <div key={row.id} ref={selected ? selectedRef : undefined} aria-current={selected ? "true" : undefined} className={`mb-2 rounded border-l-2 p-2 ${selected ? "border-amber-500 bg-amber-50" : "border-transparent bg-white"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-700">{row.speaker_id ? speakerDisplayName(speakerNames, row.speaker_id) : row.speaker_name || row.speaker_display || "Source passage"}</span>
            {driveUrl && offset && (
              <a href={driveUrl} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900">
                Drive {offset} ↗
              </a>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{row.text}</p>
        </div>;
      })}
      {mode === "gemini" && hasGeminiNotes && (
        <div className="space-y-3 p-1">
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">Threads map (this view)</p>
            {tierSummary(bundle) && <p className="mt-1 text-[11px] font-medium text-slate-700">{tierSummary(bundle)}</p>}
            {bundle.executive_summary && <p className="mt-1.5 whitespace-pre-line text-slate-700">{bundle.executive_summary}</p>}
          </div>
          {referenceNotes.summary && (
            <div className="rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Gemini summary (baseline)</p>
              <p className="mt-1 whitespace-pre-line text-slate-700">{referenceNotes.summary}</p>
            </div>
          )}
          {referenceNotes.next_steps && (
            <div className="rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Gemini next steps</p>
              <p className="mt-1 whitespace-pre-line text-slate-700">{referenceNotes.next_steps}</p>
            </div>
          )}
          {referenceNotes.quick_notes && (
            <div className="rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Gemini quick notes</p>
              <p className="mt-1 whitespace-pre-line text-slate-700">{referenceNotes.quick_notes}</p>
            </div>
          )}
        </div>
      )}
      {!transcript && !utterances.length && mode !== "gemini" && <p>No transcript text is available in this artifact.</p>}
    </div>
  </aside>;
}

TextSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, selection: PropTypes.object, compact: PropTypes.bool, onClose: PropTypes.func, onRenameSpeaker: PropTypes.func, namesStayInView: PropTypes.bool, sectionMode: PropTypes.oneOf(["transcript", "utterances", "gemini"]), onSectionChange: PropTypes.func };
