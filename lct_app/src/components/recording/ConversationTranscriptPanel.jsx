import { useMemo, useRef, useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronUp, Copy, Maximize2, Minimize2 } from 'lucide-react';

function transcriptLines(tokens) {
  const lines = [];
  for (const token of tokens || []) {
    let line = lines.at(-1);
    if (!line || (token.speaker && token.speaker !== line.speaker) || (line.text.length > 240 && /[.!?]\s*$/.test(line.text))) {
      line = { id: lines.length, text: '', speaker: token.speaker || line?.speaker, startMs: token.startMs };
      lines.push(line);
    }
    line.text += token.text;
  }
  return lines;
}

export default function ConversationTranscriptPanel({ transcript, status, minimized, onMinimize, fullscreen, onFullscreen }) {
  const lines = useMemo(() => transcriptLines(transcript.finalTokens), [transcript.finalTokens]);
  const [copyStatus, setCopyStatus] = useState('');
  const scroll = useRef(null), follow = useRef(true);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [transcript]);
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
      {!lines.length && !transcript.partialText && <p className="text-sm text-slate-500">Your words will appear here.</p>}
      {lines.map(line => <p key={line.id} className="mb-3 whitespace-pre-wrap text-sm leading-6">{line.speaker && <span className="mr-2 text-xs font-medium text-slate-500">{line.speaker.startsWith('segment-') ? line.speaker.replace(/^segment-(\d+):(.+)$/, 'Speaker $2 · part $1') : `Speaker ${line.speaker}`}</span>}{line.text}</p>)}
      {transcript.partialText && <p className="whitespace-pre-wrap text-sm leading-6 text-slate-500">{transcript.partialText}</p>}
    </div>}
  </section>;
}
ConversationTranscriptPanel.propTypes = { transcript: PropTypes.object.isRequired, status: PropTypes.string, minimized: PropTypes.bool, onMinimize: PropTypes.func.isRequired, fullscreen: PropTypes.bool, onFullscreen: PropTypes.func.isRequired };
