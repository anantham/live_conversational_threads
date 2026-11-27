import { useCallback, useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { CheckCircle2, RefreshCw, Save, Trash2 } from 'lucide-react';
import TooltipButton from '../TooltipButton';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { validPersonalKey } from '../../services/cloud/sitesProviderPreferences';

const catalogTtlMs = 24 * 60 * 60 * 1000;
const recheckMs = 15 * 60 * 1000;
const iconButton = 'inline-flex size-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40';
const rowButton = 'min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40';
const input = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm';

const formatMs = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/**
 * One provider's personal key. At rest it is a single line: whether a key is saved, how many models it
 * loaded, a Test that checks the saved key against the provider, and a toggle that reveals the key form.
 */
export default function ProviderKeyForm({ backend, name, speech = false, summaryName = false }) {
  const { keys, catalogs, catalogRecords, credentialsReady, setKey, refreshProvider } = useSitesRuntime();
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [refreshFeedback, setRefreshFeedback] = useState(null);
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState(null);
  const request = useRef(null);
  const lastAttempt = useRef(null);
  const testRun = useRef(0);
  const formId = useId();
  const key = keys[backend] || '';
  const { fetchedAt = 0, revision } = catalogRecords[backend] || {};
  const loadedCount = catalogs[backend]?.length || 0;
  // The M5 endpoint has its own reachability test beside its address; a bearer token alone proves nothing there.
  const testable = Boolean(key) && backend !== 'm5_tailnet';

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

  // A result belongs to the key it tested. Replacing or removing the key discards it.
  useEffect(() => { testRun.current += 1; setTest(null); }, [revision]);

  async function runTest() {
    if (!testable || test?.loading) return;
    const run = ++testRun.current;
    const started = performance.now();
    lastAttempt.current = { revision, at: Date.now() };
    setTest({ loading: true });
    try {
      // The same check that loads the model list: it reads account metadata and spends nothing.
      const message = await refreshProvider(backend, revision);
      if (run === testRun.current) setTest({ ok: true, message: message || 'Provider access confirmed.', ms: performance.now() - started });
    } catch (error) {
      if (run === testRun.current) setTest({ ok: false, message: error.message || 'Could not check the provider.', ms: performance.now() - started });
    }
  }

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
      setOpen(false);
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
      setOpen(false);
    } catch { setFeedback('The saved key could not be removed. Try again.'); }
    finally { setWorking(false); }
  }

  const refreshLabel = speech ? 'Test connection' : 'Refresh models';
  const currentRefresh = revision && refreshFeedback?.revision === revision ? refreshFeedback : null;
  const state = key ? `Personal key saved${loadedCount ? ` · ${loadedCount} ${loadedCount === 1 ? 'model' : 'models'}` : ''}`
    : summaryName ? 'Site configuration' : '';
  const toggleLabel = open ? 'Done' : key ? 'Edit' : 'Add key';

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {(summaryName || state) ? <span title={key ? 'Saved in this browser only' : undefined}
        className={`inline-flex min-h-8 min-w-0 items-center gap-2 text-sm ${key ? 'rounded-full bg-emerald-50 px-3 text-emerald-900 ring-1 ring-inset ring-emerald-200' : 'text-slate-600'}`}>
        {key && <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />}
        <span className="min-w-0">{summaryName && <span className={key ? 'font-medium' : 'font-medium text-slate-900'}>{name}</span>}{summaryName && state && ' · '}{state}</span>
      </span> : <span />}
      <span className="flex flex-wrap items-center gap-2">
        {testable && <button type="button" className={rowButton} aria-label={`Test ${name} key`} disabled={working || Boolean(test?.loading)} onClick={() => void runTest()}>
          {test?.loading ? 'Testing…' : 'Test'}
        </button>}
        <button type="button" className={rowButton} aria-label={`${open ? 'Done editing' : key ? 'Edit' : 'Add'} ${name} key`}
          aria-expanded={open} aria-controls={formId} onClick={() => setOpen(value => !value)}>{toggleLabel}</button>
      </span>
    </div>
    {test && !test.loading && <p role="status" className={`text-sm ${test.ok ? 'text-emerald-800' : 'text-rose-800'}`}>
      {test.message} <span className="tabular-nums text-slate-600">Round trip {formatMs(test.ms)}, through this site.</span>
    </p>}
    {feedback && <p role="status" className="text-sm text-slate-600">{feedback}</p>}
    <form id={formId} hidden={!open} onSubmit={event => void saveKey(event)} className="grid gap-3 border-t border-slate-100 pb-2 pt-3">
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
          {(!speech || !testable) && <TooltipButton compact aria-label={refreshLabel} tooltip={refreshLabel} className={iconButton}
            disabled={working || Boolean(currentRefresh?.loading)} onClick={() => void refresh(true)}>
            <RefreshCw className={currentRefresh?.loading ? 'motion-safe:animate-spin' : undefined} size={19} aria-hidden="true" />
          </TooltipButton>}
        </>}
      </div>
      {currentRefresh?.message && <p role="status" className="text-sm text-slate-600">{currentRefresh.message}</p>}
    </form>
  </div>;
}

ProviderKeyForm.propTypes = { backend: PropTypes.string.isRequired, name: PropTypes.string.isRequired, speech: PropTypes.bool, summaryName: PropTypes.bool };
