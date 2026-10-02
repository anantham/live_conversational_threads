import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import SourceSpeakerEditor from "./SourceSpeakerEditor";
import { validYouTubeRef } from "../../services/youtubeMedia";
import { buildSpeakerDisplayNames, speakerDisplayName, transcriptSpeakerLabels } from "../../services/speakerDisplay";

export default function TextSourcePanel({ bundle, selection = null, compact = false, onClose, onRenameSpeaker, sectionMode, onSectionChange }) {
  const transcript = typeof bundle.full_transcript === "string" ? bundle.full_transcript : "";
  const utterances = Array.isArray(bundle.utterances) ? bundle.utterances : [];
  const speakerNames = useMemo(() => buildSpeakerDisplayNames(bundle), [bundle]);
  const displayLabels = useMemo(() => transcriptSpeakerLabels(transcript, speakerNames), [transcript, speakerNames]);
  const unsupportedRecording = (bundle.media_refs || []).some(ref => ref?.provider === "youtube" && !validYouTubeRef(ref));
  const [localMode, setLocalMode] = useState(() => selection?.kind === "utterance" || !transcript ? "utterances" : "transcript");
  const mode = !transcript ? "utterances" : sectionMode || localMode;
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
      <button type="button" onClick={onClose} className="min-h-11 rounded px-2 text-slate-600 hover:bg-slate-100">Hide source</button>
    </div>
    {unsupportedRecording && <p role="status" className="mb-2 shrink-0 text-amber-800">YouTube source unavailable. The recording link or timing information could not be verified. You can still read the transcript below.</p>}
    {transcript && utterances.length > 0 && <div role="group" aria-label="Text source section" className="mb-2 flex gap-2">
      <button type="button" aria-pressed={mode === "transcript"} onClick={() => setMode("transcript")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Full transcript</button>
      <button type="button" aria-pressed={mode === "utterances"} onClick={() => setMode("utterances")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Passages</button>
    </div>}
    {onRenameSpeaker && <div className="max-h-[45dvh] shrink-0 overflow-y-auto"><SourceSpeakerEditor bundle={bundle} onRenameSpeaker={onRenameSpeaker} /></div>}
    <div data-viewer-scroll="text-source" aria-label="Original source passages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-100 bg-stone-50 p-2 leading-5">
      {mode === "transcript" && transcript && <pre className="whitespace-pre-wrap break-words font-sans">{renderedTranscript}</pre>}
      {mode === "utterances" && utterances.map((row) => {
        const selected = selection?.kind === "utterance" && String(row.id) === String(selection.utteranceId);
        return <div key={row.id} ref={selected ? selectedRef : undefined} aria-current={selected ? "true" : undefined} className={`mb-2 rounded border-l-2 p-2 ${selected ? "border-amber-500 bg-amber-50" : "border-transparent bg-white"}`}>
          <span className="font-medium text-slate-700">{row.speaker_id ? speakerDisplayName(speakerNames, row.speaker_id) : row.speaker_name || row.speaker_display || "Source passage"}</span>
          <p className="mt-1 whitespace-pre-wrap break-words">{row.text}</p>
        </div>;
      })}
      {!transcript && !utterances.length && <p>No transcript text is available in this artifact.</p>}
    </div>
  </aside>;
}

TextSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, selection: PropTypes.object, compact: PropTypes.bool, onClose: PropTypes.func, onRenameSpeaker: PropTypes.func, sectionMode: PropTypes.oneOf(["transcript", "utterances"]), onSectionChange: PropTypes.func };
