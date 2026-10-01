import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import SourceSpeakerEditor from "./SourceSpeakerEditor";

export default function TextSourcePanel({ bundle, selection = null, compact = false, onClose, onRenameSpeaker }) {
  const transcript = typeof bundle.full_transcript === "string" ? bundle.full_transcript : "";
  const utterances = Array.isArray(bundle.utterances) ? bundle.utterances : [];
  const [mode, setMode] = useState(() => selection?.kind === "utterance" || !transcript ? "utterances" : "transcript");
  const selectedRef = useRef(null);
  useEffect(() => {
    if (selection?.kind === "utterance") setMode("utterances");
    else if (selection?.kind === "transcript") setMode("transcript");
  }, [selection]);
  const range = useMemo(() => {
    if (selection?.kind !== "transcript") return null;
    const { start, end } = selection;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > transcript.length) return null;
    return { before: transcript.slice(0, start), match: transcript.slice(start, end), after: transcript.slice(end) };
  }, [selection, transcript]);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "center" });
  }, [mode, range, selection?.utteranceId]);

  return <aside aria-label="Text source" className={`lct-source-panel flex shrink-0 flex-col overflow-hidden border-slate-200 bg-white p-3 text-xs text-slate-700 ${compact ? "max-h-[60dvh] border-b" : "w-[360px] max-w-[38vw] border-r"}`}>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h2 className="font-medium text-slate-800">Original source text</h2>
      <button type="button" onClick={onClose} className="min-h-11 rounded px-2 text-slate-600 hover:bg-slate-100">Hide source</button>
    </div>
    {transcript && utterances.length > 0 && <div role="group" aria-label="Text source section" className="mb-2 flex gap-2">
      <button type="button" aria-pressed={mode === "transcript"} onClick={() => setMode("transcript")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Full transcript</button>
      <button type="button" aria-pressed={mode === "utterances"} onClick={() => setMode("utterances")} className="min-h-11 rounded px-2 aria-pressed:bg-amber-100">Passages</button>
    </div>}
    {onRenameSpeaker && <div className="max-h-[45dvh] shrink-0 overflow-y-auto"><SourceSpeakerEditor bundle={bundle} onRenameSpeaker={onRenameSpeaker} /></div>}
    <div aria-label="Original source passages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-100 bg-stone-50 p-2 leading-5">
      {mode === "transcript" && transcript && <pre className="whitespace-pre-wrap break-words font-sans">{range ? <>{range.before}<mark ref={selectedRef} className="bg-amber-200">{range.match}</mark>{range.after}</> : transcript}</pre>}
      {mode === "utterances" && utterances.map((row) => {
        const selected = selection?.kind === "utterance" && String(row.id) === String(selection.utteranceId);
        return <div key={row.id} ref={selected ? selectedRef : undefined} aria-current={selected ? "true" : undefined} className={`mb-2 rounded border-l-2 p-2 ${selected ? "border-amber-500 bg-amber-50" : "border-transparent bg-white"}`}>
          <span className="font-medium text-slate-700">{row.speaker_name || row.speaker_display || row.speaker_id || "Source passage"}</span>
          <p className="mt-1 whitespace-pre-wrap break-words">{row.text}</p>
        </div>;
      })}
      {!transcript && !utterances.length && <p>No transcript text is available in this artifact.</p>}
    </div>
  </aside>;
}

TextSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, selection: PropTypes.object, compact: PropTypes.bool, onClose: PropTypes.func, onRenameSpeaker: PropTypes.func };
