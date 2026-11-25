import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { MAP_PROVIDERS } from '../services/cloud/openRouterClient.js';
import { clearSitesCostEntries, readSitesCostEntries, summarizeSitesCosts } from '../services/cloud/sitesCostStore.js';
import { clearQualityLedger, readQualityLedger, summarizeQualityLedger } from '../services/cloud/qualityLedgerStore.js';

const RANGES = [
  { id: '1d', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
];

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function formatSeconds(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

function providerLabel(id) {
  if (id === 'browser') return 'Browser';
  return MAP_PROVIDERS[id]?.name || id;
}

export default function SitesCostDashboard() {
  const [timeRange, setTimeRange] = useState('7d');
  const [entries, setEntries] = useState(readSitesCostEntries);
  const [qualityRows, setQualityRows] = useState(readQualityLedger);
  const [siteStatus, setSiteStatus] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/cloud/map/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (data) setSiteStatus(data); })
      .catch(() => { /* Site status is informational here. */ });
    return () => controller.abort();
  }, []);

  const summary = useMemo(() => summarizeSitesCosts(entries, timeRange), [entries, timeRange]);
  const quality = useMemo(() => summarizeQualityLedger(qualityRows), [qualityRows]);

  function handleClear() {
    clearSitesCostEntries();
    setEntries([]);
  }

  function handleClearQuality() {
    clearQualityLedger();
    setQualityRows([]);
  }

  return (
    <main className="min-h-dvh bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-32 pt-8 font-sans text-slate-800 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <nav className="flex flex-wrap items-center justify-between gap-4 text-sm">
          <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-slate-600 underline-offset-4 hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Home
          </Link>
          <Link to="/settings/runtime" className="inline-flex min-h-11 items-center text-slate-600 underline-offset-4 hover:underline">
            Providers &amp; keys
          </Link>
        </nav>

        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-500">Usage, latency &amp; spend</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-slate-900">Costs &amp; Observability</h1>
            <p className="mt-2 max-w-[60ch] text-sm leading-6 text-slate-600">
              Tracks calls, latency, first-token speed, token counts, coverage, and errors from this browser. No transcript text or API keys are stored here; check your provider console for exact billing.
            </p>
          </div>
          <div role="group" aria-label="Time range" className="flex flex-wrap gap-1.5">
            {RANGES.map(range => (
              <button
                key={range.id}
                type="button"
                aria-pressed={timeRange === range.id}
                onClick={() => setTimeRange(range.id)}
                className={`min-h-10 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  timeRange === range.id
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </header>

        {siteStatus && (
          <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
            <span className="font-medium text-slate-900">Site generation capacity:</span>{' '}
            {siteStatus.available ? 'Available' : 'At shared limit or paused'}
            {siteStatus.personal ? ' · Personal provider keys enabled' : ''}
          </section>
        )}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Calls &amp; reliability</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(summary.calls)}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {summary.successRatePct != null ? `${summary.successRatePct}% ok · ${summary.errorCount} failed` : 'No calls yet'}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tokens &amp; throughput</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(summary.totalTokens)}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {formatNumber(summary.inputTokens)} in · {formatNumber(summary.outputTokens)} out
              {summary.avgTokensPerSec != null ? ` · ${summary.avgTokensPerSec.toFixed(0)} tok/s` : ''}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Avg latency &amp; first token</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{formatSeconds(summary.avgDurationMs)}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              First token: {formatSeconds(summary.avgTtftMs)}
              {summary.avgCoveragePct != null ? ` · ${Math.round(summary.avgCoveragePct)}% cov` : ''}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Provider-reported cost</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {summary.hasReportedCost ? formatUsd(summary.reportedCostUsd) : '—'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {summary.hasReportedCost ? 'Reported by provider' : 'Token counts only'}
            </p>
          </div>
        </section>

        {quality.callsTracked > 0 && (
          <section aria-label="Map quality and audit ledger" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Map quality &amp; audit ledger</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {quality.callsTracked} call{quality.callsTracked === 1 ? '' : 's'} tracked
                  {quality.avgRecallPct != null ? ` · avg ${quality.avgRecallPct}% audit recall` : ''}
                  {` · ${quality.totalContradictions} source conflicts · ${quality.totalUserFlags} user flags · ${quality.totalBoundaryCorrections} boundary edits`}
                </p>
              </div>
              <button type="button" onClick={handleClearQuality} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Trash2 size={13} aria-hidden="true" /> Clear ledger
              </button>
            </div>
            <ul className="mt-3 divide-y divide-slate-100 text-xs">
              {quality.rows.slice(0, 15).map(row => (
                <li key={row.conversationId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="font-medium text-slate-800">{row.title}</p>
                    <p className="text-[11px] text-slate-500">
                      {row.nodeCount} nodes
                      {row.coveragePct != null ? ` · ${row.coveragePct}% cov` : ''}
                      {row.models?.length ? ` · ${row.models.join(', ')}` : ''}
                    </p>
                  </div>
                  <div className="tabular-nums text-slate-600">
                    {row.recallPct != null ? `Recall ${row.recallPct}% (${row.represented}/${row.points}) · ` : ''}
                    {row.contradictions ? `${row.contradictions} conflicts · ` : ''}
                    {row.userFlags} flags · {row.boundaryCorrections} edits · {row.reactions} reactions
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {summary.calls === 0 ? (
          <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="text-sm font-medium text-slate-700">No generation calls recorded in this range yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              Run a map generation from <Link className="underline" to="/import-transcript">Import transcript</Link>, <Link className="underline" to="/import-audio">Import audio</Link>, or <Link className="underline" to="/new">New recording</Link> and usage will appear here automatically.
            </p>
          </section>
        ) : (
          <>
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">By provider &amp; model</h2>
              <div className="mt-3 divide-y divide-slate-100 text-sm">
                {summary.models.map(item => (
                  <div key={`${item.provider}-${item.model}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div>
                      <p className="font-medium text-slate-900">{providerLabel(item.provider)} · {item.model}</p>
                      <p className="text-xs text-slate-500">
                        {formatNumber(item.calls)} calls ({item.okCalls} ok{item.errorCalls ? `, ${item.errorCalls} err` : ''})
                        {item.avgDurationMs != null ? ` · avg ${formatSeconds(item.avgDurationMs)}` : ''}
                        {item.avgTtftMs != null ? ` · first token ${formatSeconds(item.avgTtftMs)}` : ''}
                        {item.avgTokensPerSec != null ? ` · ${item.avgTokensPerSec.toFixed(0)} tok/s` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-slate-900">{item.hasCost ? formatUsd(item.costUsd) : `${formatNumber(item.totalTokens)} tok`}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900">Recent events</h2>
                <button type="button" onClick={handleClear} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <Trash2 size={13} aria-hidden="true" /> Clear browser log
                </button>
              </div>
              <ul className="mt-3 divide-y divide-slate-100 text-xs">
                {summary.recent.map(entry => (
                  <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${entry.outcome === 'error' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}`}>
                        {entry.outcome === 'error' ? (entry.errorCode || 'error') : entry.kind}
                      </span>
                      <span className="font-medium text-slate-800">{providerLabel(entry.provider)} · {entry.model}</span>
                      <span className="text-slate-500">{new Date(entry.at).toLocaleString()}</span>
                    </div>
                    <div className="tabular-nums text-slate-600">
                      {entry.durationMs != null ? `${formatSeconds(entry.durationMs)}` : ''}
                      {entry.ttftMs != null ? ` (1st ${formatSeconds(entry.ttftMs)})` : ''}
                      {entry.totalTokens > 0 ? ` · ${formatNumber(entry.totalTokens)} tok` : ''}
                      {entry.nodes != null ? ` · ${entry.nodes} nodes` : ''}
                      {entry.coveragePct != null ? ` · ${entry.coveragePct}% cov` : ''}
                      {entry.costUsd != null ? ` · ${formatUsd(entry.costUsd)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
