import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic, Trash2 } from 'lucide-react';
import { listLocalConversations, deleteLocalConversation } from '../../services/cloud/localConversationStore.js';
export default function RecordedConversations() {
  const [records, setRecords] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; listLocalConversations().then(rows => { if (active) { setRecords(rows); setError(''); } }, () => { if (active) setError('Could not read recordings saved in this browser.'); }); return () => { active = false; }; }, [retry]);
  async function remove(record) {
    if (!window.confirm(`Remove “${record.title}” and its audio from this device? This cannot be undone. Cloud copies are not affected.`)) return;
    try { await deleteLocalConversation(record.id); setRecords(rows => rows.filter(row => row.id !== record.id)); }
    catch { setError('Could not remove this recording. Its saved copy may still be present.'); }
  }
  return <section className="mx-auto mb-8 max-w-2xl" aria-label="Recorded on this device"><h2 className="text-base font-semibold text-slate-800">Recorded on this device</h2>
    <p className="mt-2 text-xs leading-5 text-slate-500">Audio, transcripts and maps saved in this browser. Clearing site data removes these copies; download anything you want to keep elsewhere.</p>
    {error && <p role="alert" className="mt-3 text-sm text-rose-800">{error} <button className="min-h-11 underline" onClick={() => setRetry(v => v + 1)}>Retry local library</button></p>}
    {!records && !error && <p className="mt-4 text-sm">Loading recordings…</p>}
    {records?.length === 0 && <p className="mt-4 text-sm text-slate-500">No recordings saved here yet. <Link className="underline" to="/new">Start a conversation</Link></p>}
    <ul className="mt-4 space-y-2">{records?.map(record => <li key={record.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3"><Link className="flex min-h-11 min-w-0 flex-1 items-center gap-3" to={`/new?local=${encodeURIComponent(record.id)}`}><Mic className="shrink-0 text-slate-400" size={18} aria-hidden="true" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{record.title}</span><span className="mt-1 block text-xs text-slate-500">{new Date(record.updatedAt).toLocaleString()} · {record.stage === 'stopped' ? 'Finished' : 'Recovered or paused'}</span></span></Link><button className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-rose-50" aria-label={`Remove ${record.title} from this device`} onClick={() => void remove(record)}><Trash2 size={16} aria-hidden="true" /></button></li>)}</ul>
  </section>;
}
