import { useEffect, useState, useRef } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import PrivateRetentionNotice from '../PrivateRetentionNotice.jsx';
const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50';
export default function RecordingAudioFiles({ retention = 'ephemeral', audio, recordingId, privateEnabled, busy, onPrivateSave }) {
  const [files, setFiles] = useState([]), urls = useRef(new Map());
  useEffect(() => { const cache = urls.current; return () => { for (const url of cache.values()) URL.revokeObjectURL(url); cache.clear(); }; }, []);
  useEffect(() => {
    if (!audio) { for (const url of urls.current.values()) URL.revokeObjectURL(url); urls.current.clear(); setFiles([]); return; }
    const segments = audio.segments || [audio];
    const next = segments.map((segment, i) => {
      const suffix = segment.mimeType.startsWith('audio/ogg') ? 'ogg' : segment.mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm';
      if (!urls.current.has(segment.blob)) urls.current.set(segment.blob, URL.createObjectURL(segment.blob));
      return { ...segment, url: urls.current.get(segment.blob), file: new File([segment.blob], `recording-${recordingId}${segments.length > 1 ? `-part-${i + 1}` : ''}.${suffix}`, { type: segment.mimeType }) };
    });
    const retained = new Set(segments.map(s => s.blob));
    for (const [blob, url] of urls.current) if (!retained.has(blob)) { URL.revokeObjectURL(url); urls.current.delete(blob); }
    setFiles(next);
  }, [audio, recordingId]);
  if (!audio) return null;
  return <section className="mt-6" aria-label="Recorded audio"><h2 className="text-lg font-medium">Your audio</h2>
    <p className="mt-2 text-sm text-slate-600">{audio.complete ? 'Captured audio preserved.' : 'Partial audio preserved.'} {retention === 'local' ? 'Browser saving status appears above.' : 'This copy is only in this tab.'}{files.length > 1 && ' Each pause keeps a separate playable part.'}</p>
    <PrivateRetentionNotice id="audio-private-retention" />
    {files.map((item, i) => <div className="mt-4" key={item.file.name}>{files.length > 1 && <h3 className="text-sm">Part {i + 1}</h3>}<audio className="mt-2 w-full" controls src={item.url} aria-label={`Recorded audio part ${i + 1}`} /><div className="mt-3 flex flex-wrap gap-3"><a className={button} href={item.url} download={item.file.name}>Download audio{files.length > 1 ? ` part ${i + 1}` : ''}</a><button className={button} aria-describedby="audio-private-retention" disabled={!privateEnabled || busy} onClick={() => onPrivateSave(item.file, 'Audio')}>Save audio privately{files.length > 1 ? ` · part ${i + 1}` : ''}</button></div></div>)}
    {!privateEnabled && <p className="mt-3 text-sm text-slate-600">Personal cloud uploads are still being connected. You can keep or download this local recording.</p>}<Link className="mt-4 inline-block text-sm underline" to="/private-files">Browse your private files</Link>
  </section>;
}
RecordingAudioFiles.propTypes = { retention: PropTypes.string, audio: PropTypes.object, recordingId: PropTypes.string, privateEnabled: PropTypes.bool, busy: PropTypes.bool, onPrivateSave: PropTypes.func.isRequired };
