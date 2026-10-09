import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

const INTRO_KEY = 'lct.recording_intro.v1';
const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50';

export default function RecordingConsentDialog({ transcribe, maxSeconds, onCancel, onConfirm }) {
  const dialog = useRef(null), permission = useRef(null), submitting = useRef(false);
  const [consent, setConsent] = useState(false);
  const [showIntro] = useState(() => {
    try { return localStorage.getItem(INTRO_KEY) !== 'seen'; }
    catch { return true; }
  });

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element.showModal();
    permission.current?.focus();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function confirm(event) {
    event.preventDefault();
    if (!consent || submitting.current) return;
    submitting.current = true;
    // Presentation memory only: each mounted dialog still requires fresh permission.
    try { localStorage.setItem(INTRO_KEY, 'seen'); } catch { /* Recording works without browser storage. */ }
    onConfirm();
  }

  return <dialog ref={dialog} aria-labelledby="recording-consent-title" aria-describedby="recording-consent-details"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border-0 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/30 sm:p-6">
    <form onSubmit={confirm}>
      <h2 id="recording-consent-title" className="text-xl font-semibold tracking-tight">{transcribe ? 'Record and transcribe' : 'Record audio locally'}</h2>
      <div id="recording-consent-details" className="mt-3 space-y-3 text-sm leading-6 text-slate-600">
        {showIntro && <p>Your recording stays in this tab until you download it or choose a private save. Nothing is published automatically.</p>}
        {transcribe && <p>Audio streams to Soniox for live transcription. The connection stops within {maxSeconds} seconds, including finalization. Shared session limits also apply.</p>}
        <p>{transcribe ? 'Local audio is limited to 2 MiB.' : 'Local recording stops within 5 minutes or 2 MiB.'} Keep this tab open until you download or save your audio.</p>
        <a href="/privacy" target="_blank" rel="noreferrer" className="inline-block underline underline-offset-4">Privacy and data use</a>
      </div>
      <label className="mt-5 flex items-start gap-3 text-sm leading-6">
        <input ref={permission} className="mt-1.5" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        {transcribe ? 'I have permission to record everyone in this conversation and send this audio to Soniox for transcription.' : 'I have permission to record everyone in this conversation.'}
      </label>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button type="button" className={button} onClick={onCancel}>Cancel</button>
        <button type="submit" className={`${button} border-slate-900 bg-slate-900 text-white hover:bg-slate-800`} disabled={!consent}>{transcribe ? 'Start transcription' : 'Start recording'}</button>
      </div>
    </form>
  </dialog>;
}

RecordingConsentDialog.propTypes = {
  transcribe: PropTypes.bool.isRequired,
  maxSeconds: PropTypes.number,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
};
