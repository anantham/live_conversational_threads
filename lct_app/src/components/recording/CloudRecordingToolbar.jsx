import PropTypes from 'prop-types';
import { Mic, Square } from 'lucide-react';

const circle = 'flex h-14 w-14 items-center justify-center rounded-full transition-colors sm:h-11 sm:w-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const caption = 'mt-1 text-[10px] font-semibold uppercase tracking-wide select-none';

export default function CloudRecordingToolbar({
  active, supported, live, busy, stage, stopRef, onRecordLocal, onRecordTranscribe, onStop, onCancel,
}) {
  return (
    <section aria-label="Recording controls" data-stage={stage || undefined} className="flex min-w-0 items-center justify-end gap-3 sm:gap-4">
      {active ? (
        <>
          <div className="flex shrink-0 flex-col items-center">
            <button
              ref={stopRef}
              type="button"
              onClick={onStop}
              className={`${circle} bg-slate-200 text-slate-800 hover:bg-slate-300`}
              aria-label="Stop recording"
              title="Stop recording"
            >
              <Square size={18} fill="currentColor" aria-hidden="true" />
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-700`}>Stop</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800"
          >
            Cancel session
          </button>
        </>
      ) : (
        <>
          <div className="flex shrink-0 flex-col items-center">
            <button
              type="button"
              onClick={onRecordLocal}
              disabled={!supported || busy}
              className={`${circle} bg-gray-100 text-slate-600 hover:bg-gray-200`}
              aria-label="Record audio locally"
              title="Record audio locally"
            >
              <Mic size={18} aria-hidden="true" />
              <span className="sr-only">Record audio locally</span>
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-600`}>Start</span>
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <button
              type="button"
              onClick={onRecordTranscribe}
              disabled={!supported || !live || busy}
              className={`${circle} bg-gray-100 text-slate-600 hover:bg-gray-200`}
              aria-label="Record and transcribe"
              title="Record and transcribe"
            >
              <Mic size={18} aria-hidden="true" />
            </button>
            <span aria-hidden="true" className={`${caption} text-slate-600`}>Transcribe</span>
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
  stage: PropTypes.string,
  stopRef: PropTypes.shape({ current: PropTypes.any }),
  onRecordLocal: PropTypes.func.isRequired,
  onRecordTranscribe: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};
