import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { formatBytes } from '../../services/privateFiles.js';

export default function ImportPrivateFiles({ status, saving, onCheck }) {
  return <section aria-label="Private cloud copies" className="pt-12 text-sm leading-6">
    <h2 className="font-medium">Private cloud copies</h2>
    {status.state === 'ready' && <p className="mt-2 text-slate-600">Choose which files to save below, up to {formatBytes(status.limits.maxFileBytes)} each. Your browser copies stay here. Nothing is published.</p>}
    {status.state === 'guest' && <p className="mt-2 text-slate-600"><button type="button" className="min-h-11 underline" aria-controls="site-access">Sign in</button> to save private cloud copies and open them across devices.</p>}
    {status.state === 'checking' && <p role="status" className="mt-2 text-slate-600">Checking private saving…</p>}
    {['unknown', 'inactive'].includes(status.state) && <p className="mt-2 text-slate-600">Private cloud saving is unavailable. Your local files remain available.</p>}
    <div className="mt-2 flex flex-wrap gap-3">
      <button type="button" className="min-h-11 underline disabled:opacity-50" disabled={saving || status.state === 'checking'} onClick={onCheck}>Check private saving</button>
      <Link className="inline-flex min-h-11 items-center underline" to="/private-files">Private files</Link>
    </div>
  </section>;
}
ImportPrivateFiles.propTypes = { status: PropTypes.shape({ state: PropTypes.string.isRequired,
  limits: PropTypes.shape({ maxFileBytes: PropTypes.number }) }).isRequired,
  saving: PropTypes.bool.isRequired, onCheck: PropTypes.func.isRequired };
