// Test intent: lct_app/tests/intent/map-audit.md
import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { MAP_PROVIDERS } from '../../services/cloud/openRouterClient.js';
import { formatClock } from '../../services/cloud/geminiNotesParser.js';
import { auditSummary, chooseAuditRoute, decideSignal, planAuditSpans, runMapAudit } from '../../services/cloud/mapAudit.js';

const button = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const LABELS = { missed: 'Missed', contradiction: 'Contradiction', entity_split: 'Name split', represented: 'Represented' };

/** Second-family semantic audit of a finished map, with its own consent and per-finding decisions. */
export default function MapAuditPanel({ source, bundle, routes, onBundleChange }) {
  const route = useMemo(() => chooseAuditRoute(routes, bundle.built_by), [routes, bundle.built_by]);
  const spans = useMemo(() => planAuditSpans(bundle), [bundle]);
  const timeOf = useMemo(() => new Map(bundle.utterances.map(u => [u.id, u])), [bundle]);
  const spanKey = `${route?.backend}|${route?.model}|${spans.map(s => s.utteranceIds.join(',')).join(';')}`;
  const [consentKey, setConsentKey] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  // Leaving the panel (a new run hides it) cancels an audit, so its signals never land on another map.
  useEffect(() => () => abortRef.current?.abort(), []);
  const turns = spans.reduce((sum, s) => sum + s.utteranceIds.length, 0);
  const spanText = spans.map(s => `${formatClock((timeOf.get(s.utteranceIds[0])?.timestamp_start || 0) * 1000)}–${formatClock((timeOf.get(s.utteranceIds.at(-1))?.timestamp_end || 0) * 1000)}`).join(', ');
  const findings = (bundle.audit_signals || []).filter(s => s.source === 'audit' && s.kind !== 'represented');
  const summary = auditSummary(bundle);
  const providerName = route ? `${MAP_PROVIDERS[route.backend].name}${route.model ? ` (${route.model})` : ''}` : '';

  async function start() {
    if (!route || consentKey !== spanKey || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setError('');
    try {
      const audited = await runMapAudit({ source, bundle, route, segments: spans, signal: controller.signal,
        onProgress: event => setProgress(event.phase === 'audit' ? `Auditing span ${event.segmentIndex + 1} of ${event.totalSegments}…` : 'Audit complete.') });
      // No quality-ledger row here: the audited map is not saved yet. Saving it records one (the row is
      // computed from the map, so the audit signals are kept).
      onBundleChange(audited);
    } catch (cause) {
      setError(cause?.name === 'AbortError' ? 'Audit cancelled. The map is unchanged.' : cause?.message || 'The audit did not finish.');
      setProgress('');
    } finally { abortRef.current = null; setRunning(false); }
  }

  return (
    <section aria-label="Map audit" className="space-y-3 border-t border-slate-200 pt-4">
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <ShieldCheck size={13} aria-hidden="true" /> Audit by a different model family
      </p>
      {!route ? (
        <p className="text-sm text-slate-600">
          Add a provider from a different model family than the ones that built this map in <Link className="underline" to="/settings/runtime">Settings → Providers</Link> to audit it.
        </p>
      ) : (
        <>
          <p className="text-sm leading-6 text-slate-600">
            {providerName} reads {spans.length} span{spans.length === 1 ? '' : 's'} on its own, lists what was decided, reversed or committed, then checks which map nodes represent each point.
          </p>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input type="checkbox" className="mt-1" checked={consentKey === spanKey} disabled={running || !spans.length}
              onChange={event => setConsentKey(event.target.checked ? spanKey : null)} />
            I have permission to send {turns} transcript turns ({spanText}), plus the names and summaries of the map nodes covering them (including their themes and arcs), to {MAP_PROVIDERS[route.backend].recipient}{route.model ? ` (model ${route.model})` : ''}.
          </label>
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={running || consentKey !== spanKey} onClick={() => void start()}>
              {running ? 'Auditing…' : 'Run audit'}
            </button>
            {running && <button type="button" className={button} onClick={() => abortRef.current?.abort()}>Cancel</button>}
          </div>
        </>
      )}
      {progress && <p role="status" className="text-xs text-slate-600">{progress}</p>}
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {summary.points + summary.contradictions + summary.entitySplits > 0 && (
        <p className="text-xs text-slate-600">
          {summary.represented} of {summary.points} independent points represented · {summary.missed} missed · {summary.contradictions} contradictions · {summary.entitySplits} name splits · {summary.pending} awaiting your decision
        </p>
      )}
      {findings.length > 0 && (
        <ul className="space-y-2">
          {findings.map(item => (
            <li key={item.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-slate-900">{LABELS[item.kind] || item.kind}{item.point_kind ? ` · ${item.point_kind}` : ''}</span>
                {item.utterance_ids?.length > 0 && (
                  <span className="text-xs text-slate-500">
                    {formatClock((timeOf.get(item.utterance_ids[0])?.timestamp_start || 0) * 1000)} · {item.utterance_ids[0]}{item.utterance_ids.length > 1 ? `–${item.utterance_ids.at(-1)}` : ''}
                  </span>
                )}
              </div>
              <p className="mt-1 text-slate-700">{item.note}{item.canonical ? ` (${item.canonical}: ${item.variants.join(', ')})` : ''}</p>
              <div className="mt-2 flex items-center gap-2">
                {item.decision === 'pending' ? (
                  <>
                    <button type="button" className={button} onClick={() => onBundleChange(decideSignal(bundle, item.id, 'accepted'))}>Accept</button>
                    <button type="button" className={button} onClick={() => onBundleChange(decideSignal(bundle, item.id, 'dismissed'))}>Dismiss</button>
                  </>
                ) : (
                  <span className="text-xs text-slate-500">{item.decision === 'accepted' ? 'Accepted' : 'Dismissed'} · <button type="button" className="underline" onClick={() => onBundleChange(decideSignal(bundle, item.id, 'pending'))}>undo</button></span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
MapAuditPanel.propTypes = {
  source: PropTypes.object.isRequired,
  bundle: PropTypes.object.isRequired,
  routes: PropTypes.array.isRequired,
  onBundleChange: PropTypes.func.isRequired,
};
