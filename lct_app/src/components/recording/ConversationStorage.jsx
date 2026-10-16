import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
export function ConversationStorageSettings({ preference, onChange, error }) {
  return <fieldset className="mt-6 border-t border-slate-200 pt-4"><legend className="pt-4 text-sm font-medium">Save new conversations</legend>
    <label className="mt-3 flex gap-3 text-sm"><input type="radio" name="conversation-retention" checked={preference === 'local'} onChange={() => onChange('local')} />On this device</label>
    <p className="ml-6 mt-1 text-xs leading-5 text-slate-500">Automatically keep audio, transcripts and maps in this browser.</p>
    <label className="mt-3 flex gap-3 text-sm"><input type="radio" name="conversation-retention" checked={preference === 'ephemeral'} onChange={() => onChange('ephemeral')} />Ephemeral</label>
    <p className="ml-6 mt-1 text-xs leading-5 text-slate-500">Keep this conversation only in its tab. No automatic saving on this device.</p>
    <p className="mt-3 text-xs leading-5 text-slate-500">Applies to your next recording. Existing saved copies stay until you remove them. Cloud saving and public sharing are always your choice.</p>
    {error && <p role="alert" className="mt-2 text-xs text-rose-800">{error}</p>}
  </fieldset>;
}
ConversationStorageSettings.propTypes = { preference: PropTypes.string.isRequired, onChange: PropTypes.func.isRequired, error: PropTypes.string };
export function ConversationStorageStatus({ status, preference, onRetry }) {
  const text = { idle: preference === 'ephemeral' ? 'Ephemeral · nothing saved on this device' : 'Audio and maps save automatically on this device', waiting: 'Waiting for recording data · saving on this device', saving: 'Saving on this device…', saved: 'Saved on this device', ephemeral: 'Ephemeral · download before closing this tab', error: status.message }[status.state];
  return <div className="flex flex-wrap items-center gap-x-3 text-xs" role={status.state === 'error' ? 'alert' : 'status'}><span className={status.state === 'error' ? 'text-rose-800' : ''}>{text}</span>{status.state === 'error' && <button className="min-h-8 underline" onClick={onRetry}>Retry browser saving</button>}<Link className="min-h-8 content-center underline underline-offset-2" to="/browse">On this device</Link></div>;
}
ConversationStorageStatus.propTypes = { status: PropTypes.object.isRequired, preference: PropTypes.string.isRequired, onRetry: PropTypes.func.isRequired };
