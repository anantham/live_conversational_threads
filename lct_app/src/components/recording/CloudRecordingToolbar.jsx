import PropTypes from 'prop-types';
import { Mic, Square, Pause, Play } from 'lucide-react';

const circle = 'flex h-14 w-14 items-center justify-center rounded-full transition-colors sm:h-11 sm:w-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const caption = 'mt-1 text-[10px] font-semibold uppercase tracking-wide select-none';

export default function CloudRecordingToolbar({
  active, supported, live, busy, transcribe, stage, stopRef, resumeRef, onTranscribeChange, onStart, onStop, onCancel, onPause, onResume,
}) {
  const modeDescription = transcribe
    ? live ? 'Audio + live transcript' : 'Unavailable · turn off for audio only'
    : live ? 'Audio only' : 'Audio only · transcription unavailable';
  return (
    <section aria-label="Recording controls" data-stage={stage || undefined} className="flex min-w-0 items-center justify-end gap-3 sm:gap-4">
      {active || stage === 'paused' ? (
        <>
          {(stage === 'recording' || stage === 'paused' || stage === 'finalizing') && <div className="flex shrink-0 flex-col items-center">
            <button ref={resumeRef} type="button" onClick={stage === 'paused' ? onResume : onPause} disabled={stage === 'finalizing' || (stage === 'paused' && busy)}
              className={`${circle} bg-slate-800 text-white hover:bg-slate-700`}
              aria-label={stage === 'paused' ? 'Resume recording' : 'Pause recording'}>
              {stage === 'paused' ? <Play size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-700`}>{stage === 'paused' ? 'Resume' : 'Pause'}</span>
          </div>}
          <div className="flex shrink-0 flex-col items-center">
            <button ref={stopRef} type="button" onClick={onStop}
              className={`${circle} bg-slate-200 text-slate-800 hover:bg-slate-300`}
              aria-label="Stop recording" title="Stop recording">
              <Square size={18} fill="currentColor" aria-hidden="true" />
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-700`}>Stop</span>
          </div>
          <button type="button" onClick={onCancel}
            className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800">
            Cancel session
          </button>
        </>
      ) : (
        <>
          <div className="min-w-0 max-w-56">
            <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-700">
              <span className="relative inline-flex shrink-0">
                <input type="checkbox" role="switch" aria-label="Live transcription" aria-describedby="recording-mode-description"
                  checked={transcribe} disabled={!supported || busy || (!live && !transcribe)}
                  onChange={event => onTranscribeChange(event.target.checked)} className="peer sr-only" />
                <span aria-hidden="true" className="h-6 w-10 rounded-full bg-slate-200 transition-colors peer-checked:bg-slate-800 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-800 peer-disabled:opacity-50" />
                <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
              </span>
              Live transcription
            </label>
            <p id="recording-mode-description" className="text-[11px] leading-4 text-slate-500">{modeDescription}</p>
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <button type="button" onClick={onStart} disabled={!supported || busy || (transcribe && !live)}
              className={`${circle} bg-slate-800 text-white hover:bg-slate-700`}
              aria-label="Start session" aria-describedby="recording-mode-description" title={transcribe ? 'Record and transcribe' : 'Record audio only'}>
              <Mic size={18} aria-hidden="true" />
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-600`}>Start</span>
          </div>
        </>
      )}
    </section>
  );
}

CloudRecordingToolbar.propTypes = {
  active: PropTypes.bool.isRequired,
  supported: PropTypes.bool.isRequired,
  live: PropTypes.bool,
  busy: PropTypes.bool.isRequired,
  transcribe: PropTypes.bool.isRequired,
  stage: PropTypes.string,
  stopRef: PropTypes.shape({ current: PropTypes.any }),
  resumeRef: PropTypes.shape({ current: PropTypes.any }),
  onTranscribeChange: PropTypes.func.isRequired,
  onStart: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
  onPause: PropTypes.func,
  onResume: PropTypes.func,
  onCancel: PropTypes.func.isRequired,
};
