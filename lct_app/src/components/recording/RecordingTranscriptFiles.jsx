import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import PrivateRetentionNotice from '../PrivateRetentionNotice.jsx';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

export default function RecordingTranscriptFiles({ artifact, privateEnabled, saving, onPrivateSave }) {
  const [url, setURL] = useState('');
  useEffect(() => {
    if (!artifact?.file) { setURL(''); return; }
    const next = URL.createObjectURL(artifact.file); setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [artifact]);
  if (!artifact) return null;
  if (artifact.error) return <p role="alert" className="mt-5 text-sm text-rose-900">{artifact.error}</p>;
  return <section className="mt-8" aria-label="Transcript file">
    <h2 className="text-lg font-medium">Transcript file</h2>
    <p className="mt-3 text-sm leading-6 text-slate-600">{artifact.document.transcription_complete ? 'Transcription completed.' : 'Partial transcript preserved.'} This file keeps finalized words, speaker labels and timing. It stays in this tab until you download it or choose a private save.</p>
    <PrivateRetentionNotice id="transcript-private-retention" />
    <div className="mt-4 flex flex-wrap gap-3">
      {url && <a className={button} href={url} download={artifact.filename}>Download transcript</a>}
      <button className={button} aria-describedby="transcript-private-retention" disabled={!privateEnabled || saving} onClick={() => onPrivateSave(artifact.file, 'Transcript')}>Save transcript privately</button>
    </div>
    {!privateEnabled && <p className="mt-3 text-sm text-slate-600">Personal cloud uploads are still being connected. Private saving will require sign-in.</p>}
    <details className="mt-4 text-sm"><summary className="cursor-pointer">Copy recording data if download is unavailable</summary>
      <label className="mt-3 block" htmlFor="recording-transcript-json">Recording transcript JSON</label>
      <textarea id="recording-transcript-json" readOnly value={artifact.json} rows={5} className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm" />
    </details>
  </section>;
}

RecordingTranscriptFiles.propTypes = {
  artifact: PropTypes.object,
  privateEnabled: PropTypes.bool,
  saving: PropTypes.bool.isRequired,
  onPrivateSave: PropTypes.func.isRequired,
};
