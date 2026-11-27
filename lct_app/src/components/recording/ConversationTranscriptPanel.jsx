import { useMemo, useRef, useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronUp, Copy, Maximize2, Minimize2 } from 'lucide-react';

function transcriptLines(tokens) {
  const lines = [];
  for (const token of tokens || []) {
    let line = lines.at(-1);
    if (!line || (token.speaker && token.speaker !== line.speaker) || (line.text.length > 240 && /[.!?]\s*$/.test(line.text))) {
      line = { id: lines.length, text: '', speaker: token.speaker || line?.speaker, displaySpeaker: token.displaySpeaker, startMs: token.startMs };
      lines.push(line);
    }
    line.text += token.text;
  }
  return lines;
}

const defaultSpeakerLabel = line => line.displaySpeaker
  || (line.speaker.startsWith('segment-') ? line.speaker.replace(/^segment-(\d+):(.+)$/, 'Speaker $2 · part $1') : `Speaker ${line.speaker}`);

const labelClass = 'mr-2 text-xs font-medium text-slate-500';

/** A speaker label that turns into a name field. One name applies to every turn from that speaker. */
function SpeakerLabel({ speaker, label, named, onRename, onEditingChange }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const field = useRef(null), trigger = useRef(null), returnFocus = useRef(false), open = useRef(false);
  useEffect(() => {
    if (editing) { field.current?.focus(); field.current?.select(); }
    else if (returnFocus.current) { returnFocus.current = false; trigger.current?.focus(); }
  }, [editing]);
  useEffect(() => { if (!editing) return undefined; onEditingChange(true); return () => onEditingChange(false); }, [editing, onEditingChange]);
  function finish(save, keepFocus) {
    // Enter removes the field, which blurs it, so two endings can arrive before the next render. A ref, not
    // state, makes only the first one act.
    if (!open.current) return;
    open.current = false;
    returnFocus.current = keepFocus;
    setEditing(false);
    const name = draft.trim();
    if (save && name && name !== label) onRename(speaker, name);
  }
  if (!editing) return <button ref={trigger} type="button" aria-label={`Rename ${label}`} title="Rename this speaker"
    onClick={() => { open.current = true; setDraft(named ? label : ''); setEditing(true); }}
    className={`${labelClass} -my-1 rounded py-1 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-700`}>{label}</button>;
  // A bare input, not a form: the label sits inside a paragraph, where a form is not valid markup.
  return <input ref={field} aria-label={`Name for ${label}`} aria-describedby="speaker-rename-hint" value={draft} maxLength={80} placeholder={label}
    onChange={event => setDraft(event.target.value)} onBlur={() => finish(true, false)}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true, true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false, true); }
    }}
    className="mr-2 h-7 w-36 rounded border border-slate-300 bg-white px-2 align-baseline text-xs text-slate-800" />;
}
SpeakerLabel.propTypes = { speaker: PropTypes.string.isRequired, label: PropTypes.string.isRequired, named: PropTypes.bool, onRename: PropTypes.func.isRequired, onEditingChange: PropTypes.func.isRequired };

export default function ConversationTranscriptPanel({ transcript, status, minimized, onMinimize, fullscreen, onFullscreen, speakerNames, onRenameSpeaker }) {
  const lines = useMemo(() => transcriptLines(transcript.finalTokens), [transcript.finalTokens]);
  const [copyStatus, setCopyStatus] = useState(''), [editors, setEditors] = useState(0);
  const scroll = useRef(null), follow = useRef(true), editing = useRef(0);
  const trackEditing = useRef(open => { editing.current += open ? 1 : -1; setEditors(editing.current); }).current;
  // New words keep arriving while a name is being typed; following them would scroll the field out of view.
  useEffect(() => { if (follow.current && !editing.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [transcript]);
  async function copy() {
    try { await navigator.clipboard.writeText(transcript.finalText); setCopyStatus('Copied confirmed transcript.'); }
    catch { setCopyStatus('Select the transcript text to copy it.'); }
  }
  return <section aria-label="Live transcript" className={`flex shrink-0 flex-col border-t border-slate-200 bg-white ${fullscreen ? 'absolute inset-0 z-30' : minimized ? 'h-14' : 'h-[26vh] sm:h-[34vh] min-h-32 max-h-[45%]'}`}>
    <div className="flex shrink-0 items-center gap-2 px-4 text-xs">
      <button type="button" aria-expanded={!minimized} onClick={onMinimize} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left font-medium" aria-label={minimized ? 'Expand transcript' : 'Collapse transcript'}>
        {minimized ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />} Transcript <span className="truncate font-normal text-slate-500">{status}</span>
      </button>
      {!minimized && <><button className="flex min-h-11 min-w-11 items-center justify-center" onClick={() => void copy()} disabled={!transcript.finalText} aria-label="Copy transcript"><Copy size={16} aria-hidden="true" /></button><button className="flex min-h-11 min-w-11 items-center justify-center" onClick={onFullscreen} aria-label={fullscreen ? 'Exit full screen transcript' : 'Full screen transcript'}>{fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}</button></>}
    </div>
    {!minimized && <div ref={scroll} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4" role="region" aria-label="Transcript history" tabIndex={0}>
      {copyStatus && <p role="status" className="mb-2 text-xs text-slate-500">{copyStatus}</p>}
      {onRenameSpeaker && <p id="speaker-rename-hint" className={editors ? 'mb-2 text-xs text-slate-500' : 'sr-only'}>The name replaces this speaker’s label on every turn and in the map. Enter saves, Escape cancels.</p>}
      {!lines.length && !transcript.partialText && <p className="text-sm text-slate-500">Your words will appear here.</p>}
      {lines.map(line => {
        if (!line.speaker) return <p key={line.id} className="mb-3 whitespace-pre-wrap text-sm leading-6">{line.text}</p>;
        const name = speakerNames?.[line.speaker];
        const label = name || defaultSpeakerLabel(line);
        // Keyed by speaker as well as position: if a line ever changes hands, an open name field closes
        // instead of saving its name against the wrong speaker.
        return <p key={`${line.id}:${line.speaker}`} className="mb-3 whitespace-pre-wrap text-sm leading-6">
          {onRenameSpeaker ? <SpeakerLabel speaker={line.speaker} label={label} named={Boolean(name)} onRename={onRenameSpeaker} onEditingChange={trackEditing} />
            : <span className={labelClass}>{label}</span>}{line.text}</p>;
      })}
      {transcript.partialText && <p className="whitespace-pre-wrap text-sm leading-6 text-slate-500">{transcript.partialText}</p>}
    </div>}
  </section>;
}
ConversationTranscriptPanel.propTypes = { transcript: PropTypes.object.isRequired, status: PropTypes.string, minimized: PropTypes.bool, onMinimize: PropTypes.func.isRequired, fullscreen: PropTypes.bool, onFullscreen: PropTypes.func.isRequired,
  speakerNames: PropTypes.object, onRenameSpeaker: PropTypes.func };
