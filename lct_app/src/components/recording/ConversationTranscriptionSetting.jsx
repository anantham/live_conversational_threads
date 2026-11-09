import PropTypes from 'prop-types';

export default function ConversationTranscriptionSetting({ supported, live, busy, transcribe, onChange }) {
  const modeDescription = transcribe
    ? live ? 'Audio + live transcript' : 'Unavailable · turn off for audio only'
    : live ? 'Audio only' : 'Audio only · transcription unavailable';
  return (
    <div className="mt-4">
      <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-700">
        <span className="relative inline-flex shrink-0">
          <input type="checkbox" role="switch" aria-label="Live transcription" aria-describedby="recording-mode-description"
            checked={transcribe} disabled={!supported || busy || (!live && !transcribe)}
            onChange={event => onChange(event.target.checked)} className="peer sr-only" />
          <span aria-hidden="true" className="h-6 w-10 rounded-full bg-slate-200 transition-colors peer-checked:bg-slate-800 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-800 peer-disabled:opacity-50" />
          <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
        </span>
        Live transcription
      </label>
      <p id="recording-mode-description" className="text-[11px] leading-4 text-slate-500">{modeDescription}</p>
    </div>
  );
}

ConversationTranscriptionSetting.propTypes = {
  supported: PropTypes.bool.isRequired, live: PropTypes.bool.isRequired, busy: PropTypes.bool.isRequired,
  transcribe: PropTypes.bool.isRequired, onChange: PropTypes.func.isRequired,
};
