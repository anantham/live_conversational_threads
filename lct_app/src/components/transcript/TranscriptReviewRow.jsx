import { memo, useState } from "react";
import PropTypes from "prop-types";
import { containsTime, mediaTime, timedWords, timeLabel } from "./transcriptReviewTiming";

const action = "min-h-11 rounded px-3 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 disabled:opacity-50";
function TranscriptReviewRow({ row, currentTime, canSeek, onSeek, onSave, busy, onEditing }) {
  const [draft, setDraft] = useState(null);
  const [undo, setUndo] = useState(null);
  const [saved, setSaved] = useState(false);
  const words = timedWords(row);
  const active = canSeek && containsTime(row.timestamp_start, row.timestamp_end, currentTime);
  const startEdit = () => { if (busy || draft !== null) return; setDraft(row.text); setSaved(false); onEditing(); };
  const save = async (text) => {
    const before = row.text;
    if (await onSave(row, text)) { setDraft(null); setUndo(before); setSaved(true); }
  };
  return <article data-utterance-id={row.id} data-active={active || undefined}
    className={`py-5 ${active ? "bg-amber-50" : ""}`}>
    <div className="flex flex-wrap items-center gap-x-3">
      <h3 className="min-w-0 break-words text-sm font-semibold text-slate-800">{row.speaker_name || row.speaker_id || "Unknown speaker"}</h3>
      <button type="button" className={`${action} tabular-nums`} disabled={!canSeek || mediaTime(row.timestamp_start) == null}
        aria-label={`Play passage at ${timeLabel(row.timestamp_start)}`} onClick={() => onSeek(row.timestamp_start)}>{timeLabel(row.timestamp_start)}</button>
      <button type="button" className={`${action} ml-auto`} disabled={busy || draft !== null} onClick={startEdit}>Edit</button>
    </div>
    {draft !== null ? <form onSubmit={(event) => { event.preventDefault(); if (!busy && draft.trim()) void save(draft); }}>
      <textarea aria-label={`Edit passage by ${row.speaker_name || row.speaker_id || "Unknown speaker"}`} value={draft}
        autoFocus disabled={busy} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) { event.preventDefault(); setDraft(null); }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); if (!busy && draft.trim()) void save(draft);
          }
        }} className="mt-2 min-h-28 w-full resize-y rounded border border-slate-300 bg-white p-3 text-base leading-relaxed text-slate-800 caret-amber-700 focus:outline-2 focus:outline-amber-700" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !draft.trim()} className={`${action} bg-slate-800 text-white hover:bg-slate-700`}>Save</button>
        <button type="button" disabled={busy} className={action} onClick={() => setDraft(null)}>Cancel</button>
        <span className="text-xs text-slate-600">Enter saves. Shift+Enter adds a line.</span>
      </div>
    </form> : <p onDoubleClick={startEdit} className="whitespace-pre-wrap break-words text-base leading-8 text-slate-800 selection:bg-amber-200">
      {canSeek && words.length ? words.map((word, index) => <span key={index}>
        <button type="button" onClick={() => onSeek(word.start)}
          aria-label={`Play word ${word.word} at ${timeLabel(word.start)}`}
          className={`rounded-sm text-left hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 ${containsTime(word.start, word.end, currentTime) ? "bg-amber-200" : ""}`}>{word.word}</button>{index < words.length - 1 ? " " : ""}
      </span>) : row.text}
    </p>}
    {saved && draft === null && <div className="mt-1 flex items-center gap-2 text-xs text-slate-600">
      <span role="status">Saved</span>
      <button type="button" disabled={busy} className={action} onClick={() => void save(undo)}>Undo</button>
    </div>}
  </article>;
}
TranscriptReviewRow.propTypes = { row: PropTypes.object.isRequired, currentTime: PropTypes.number.isRequired,
  canSeek: PropTypes.bool.isRequired, onSeek: PropTypes.func.isRequired, onSave: PropTypes.func.isRequired,
  busy: PropTypes.bool.isRequired, onEditing: PropTypes.func.isRequired };
export default memo(TranscriptReviewRow);
