import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { RefreshCw, Save, Trash2 } from 'lucide-react';
import TooltipButton from '../TooltipButton';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { validPersonalKey } from '../../services/cloud/sitesProviderPreferences';

const catalogTtlMs = 24 * 60 * 60 * 1000;
const recheckMs = 15 * 60 * 1000;
const iconButton = 'inline-flex size-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40';
const input = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm';

export default function ProviderKeyForm({ backend, name, speech = false }) {
  const { keys, catalogs, catalogRecords, credentialsReady, setKey, refreshProvider } = useSitesRuntime();
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [refreshFeedback, setRefreshFeedback] = useState(null);
  const [working, setWorking] = useState(false);
  const request = useRef(null);
  const lastAttempt = useRef(null);
  const key = keys[backend] || '';
  const { fetchedAt = 0, revision } = catalogRecords[backend] || {};
  const loadedCount = catalogs[backend]?.length || 0;

  const refresh = useCallback(async (manual = false) => {
    if (!revision || request.current?.revision === revision) return;
    const active = { revision };
    request.current = active;
    lastAttempt.current = { revision, at: Date.now() };
    setRefreshFeedback({ revision, loading: true, message: '' });
    try {
      const message = await refreshProvider(backend, revision);
      if (request.current === active) setRefreshFeedback({ revision, message: manual ? message : '' });
    } catch (error) {
      if (request.current === active) setRefreshFeedback({ revision, message: error.message || 'Could not check the provider.' });
    } finally {
      if (request.current === active) request.current = null;
    }
  }, [backend, refreshProvider, revision]);

  useEffect(() => {
    if (speech || !revision) return;
    function refreshIfStale() {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (fetchedAt && now - fetchedAt < catalogTtlMs) return;
      if (lastAttempt.current?.revision === revision && now - lastAttempt.current.at < recheckMs) return;
      void refresh();
    }
    refreshIfStale();
    const timer = setInterval(refreshIfStale, recheckMs);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [fetchedAt, refresh, revision, speech]);

  async function saveKey(event) {
    event.preventDefault();
    const value = draft.trim();
    if (working || !credentialsReady || !validPersonalKey(value) || value === key) return;
    setWorking(true);
    setFeedback('');
    try {
      await setKey(backend, value);
      setDraft('');
      setFeedback('Key saved in this browser.');
    } catch {
      setFeedback('The key could not be saved in this browser.');
    } finally { setWorking(false); }
  }

  async function removeKey() {
    setWorking(true);
    setFeedback('');
    try {
      await setKey(backend, '');
      lastAttempt.current = null;
      setFeedback('Personal key and cached models removed.');
    } catch { setFeedback('The saved key could not be removed. Try again.'); }
    finally { setWorking(false); }
  }

  const refreshLabel = speech ? 'Test connection' : 'Refresh models';
  const currentRefresh = revision && refreshFeedback?.revision === revision ? refreshFeedback : null;

  return <details className="border-t border-slate-100 pt-2">
    <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium text-slate-700">
      {key ? `Personal key saved in this browser${loadedCount ? ` · ${loadedCount} ${loadedCount === 1 ? 'model' : 'models'} loaded` : ''}` : backend === 'openai' ? 'Add a personal key' : 'Configure a personal key'}
    </summary>
    <form onSubmit={event => void saveKey(event)} className="grid gap-3 pb-2 pt-2">
      <label className="grid gap-1 text-sm">{name} API key
        <input className={input} type="password" autoComplete="new-password" value={draft} maxLength={512}
          placeholder={key ? 'Enter a replacement key' : 'Enter your API key'} onChange={event => setDraft(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <TooltipButton type="submit" compact aria-label="Save key" tooltip="Save key" className={iconButton}
          disabled={!credentialsReady || working || !validPersonalKey(draft.trim()) || draft.trim() === key}>
          <Save size={19} aria-hidden="true" />
        </TooltipButton>
        {key && <>
          <TooltipButton compact aria-label="Remove key" tooltip="Remove key" className={iconButton}
            disabled={working} onClick={() => void removeKey()}>
            <Trash2 size={19} aria-hidden="true" />
          </TooltipButton>
          <TooltipButton compact aria-label={refreshLabel} tooltip={refreshLabel} className={iconButton}
            disabled={working || Boolean(currentRefresh?.loading)} onClick={() => void refresh(true)}>
            <RefreshCw className={currentRefresh?.loading ? 'motion-safe:animate-spin' : undefined} size={19} aria-hidden="true" />
          </TooltipButton>
        </>}
      </div>
      {feedback && <p role="status" className="text-sm text-slate-600">{feedback}</p>}
      {currentRefresh?.message && <p role="status" className="text-sm text-slate-600">{currentRefresh.message}</p>}
    </form>
  </details>;
}

ProviderKeyForm.propTypes = { backend: PropTypes.string.isRequired, name: PropTypes.string.isRequired, speech: PropTypes.bool };
