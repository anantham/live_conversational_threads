import { useState } from 'react';
import PropTypes from 'prop-types';
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  Cpu,
  Loader2,
  RefreshCw,
  Star,
  Zap,
} from 'lucide-react';

import { runState } from './backendState';

// ── presentation helpers ────────────────────────────────────────────────────

function runtimeIcon(runtime) {
  if (!runtime) return Cpu;
  if (runtime.startsWith('cloud-')) return Cloud;
  if (runtime === 'm5-ane' || runtime === 'tailscale-rtx') return Zap;
  return Cpu;
}

function locTag(runtime) {
  if (!runtime) return 'local';
  if (runtime.startsWith('cloud-')) return 'cloud';
  if (runtime === 'm5-ane') return 'ANE';
  if (runtime === 'tailscale-rtx') return 'RTX';
  return 'local';
}

function shortName(entry) {
  return String(entry.display_name || '').split(' (')[0];
}

// How a measured number was obtained — never call vendor/ping numbers "benchmark".
function sourceLabel(src) {
  if (!src) return 'benchmark';
  if (src.startsWith('benchmark') || src.startsWith('llm_bench')) return 'benchmark';
  if (src === 'vendor_published') return 'vendor est.';
  if (src === 'field_observation') return 'observed';
  if (src === 'local_stt_server_verified') return 'measured';
  if (src === 'live_telemetry') return 'live';
  return 'benchmark';
}

function headlineMetric(entry, capability) {
  const m = entry.measured || {};
  const o = entry.observed || null;
  if (capability === 'llm') {
    if (o && o.avg_tokens_per_sec) return `${o.avg_tokens_per_sec} tok/s`;
    if (m.tokens_per_sec) return `${m.tokens_per_sec} tok/s`;
    return null;
  }
  if (capability === 'diarization') {
    return entry.emits_embeddings ? 'voice-ID' : 'labels';
  }
  if (m.speedup_vs_realtime) return `${Math.round(m.speedup_vs_realtime * 10) / 10}×`;
  return null;
}

function speedDetail(entry, capability) {
  const m = entry.measured || {};
  const o = entry.observed || null;
  let seed = null;
  if (capability === 'llm') seed = m.tokens_per_sec ? `${m.tokens_per_sec} tok/s` : null;
  else if (m.speedup_vs_realtime) seed = `${Math.round(m.speedup_vs_realtime * 10) / 10}× realtime`;
  let live = null;
  if (o) {
    if (capability === 'llm' && o.avg_tokens_per_sec) live = `${o.avg_tokens_per_sec} tok/s`;
    else if (o.avg_request_ms) live = `${Math.round(o.avg_request_ms)} ms/req`;
    else if (o.avg_final_ms) live = `${Math.round(o.avg_final_ms)} ms`;
  }
  return { seed, seedLabel: sourceLabel(m.source), live, samples: o ? o.samples : null };
}

function accuracyText(entry, capability) {
  const m = entry.measured || {};
  if (capability === 'stt') {
    if (m.wer_vs_ref === 0) return 'reference';
    if (typeof m.wer_vs_ref === 'number') return `WER ${m.wer_vs_ref.toFixed(3)} vs ref`;
    return null;
  }
  if (capability === 'diarization') return entry.emits_embeddings ? 'embeddings ✓ (voice-ID)' : 'labels only';
  if (capability === 'llm') {
    const o = entry.observed;
    if (o && typeof o.valid_json_rate === 'number') return `${Math.round(o.valid_json_rate * 100)}% valid JSON`;
    if (typeof m.valid_graph_json_rate === 'number') return `${Math.round(m.valid_graph_json_rate * 100)}% valid JSON`;
    return 'quality: pending';
  }
  return null;
}

function costInfo(entry) {
  const c = entry.cost || {};
  if (c.free_local) return { short: 'Free', full: 'Free · local', cls: 'text-emerald-700' };
  if (typeof c.per_minute === 'number')
    return { short: `$${c.per_minute}/min`, full: `~$${c.per_minute}/min${c.approximate ? ' (approx)' : ''}`, cls: 'text-amber-700' };
  if (typeof c.per_million_tokens === 'number')
    return { short: '$', full: `~$${c.per_million_tokens}/1M tok${c.approximate ? ' (approx)' : ''}`, cls: 'text-amber-700' };
  return { short: 'Paid', full: 'Paid', cls: 'text-amber-700' };
}

// state → dot / border / badge — all derived from the SAME runState.
function dotFor(state, probe) {
  switch (state) {
    case 'running': {
      const ms = probe && typeof probe.latency_ms === 'number' ? ` · ${Math.round(probe.latency_ms)} ms ping` : '';
      return { cls: 'bg-emerald-500', title: `Online${ms}` };
    }
    case 'offline':
      return { cls: 'bg-rose-500', title: (probe && probe.error) || 'Offline' };
    case 'not_running':
      return { cls: 'bg-amber-300', title: 'Not running yet' };
    case 'checking':
      return { cls: 'bg-slate-300 animate-pulse', title: 'Checking…' };
    case 'unverifiable':
      return { cls: 'bg-slate-300', title: (probe && probe.note) || 'Not probed (cloud / no health endpoint)' };
    default:
      return { cls: 'bg-slate-300', title: 'Unknown' };
  }
}

const PRIMARY_BADGE = {
  running: { text: 'ACTIVE', cls: 'bg-emerald-600 text-white' },
  offline: { text: 'OFFLINE', cls: 'bg-rose-100 text-rose-700' },
  checking: { text: 'CHECKING…', cls: 'bg-slate-100 text-slate-600' },
  unverifiable: { text: 'SELECTED', cls: 'bg-slate-100 text-slate-600' },
};

function primaryBadge(state, entry) {
  if (state === 'not_running') {
    return { text: entry.status === 'install_failed' ? 'UNAVAILABLE' : 'NOT RUNNING', cls: 'bg-amber-100 text-amber-800' };
  }
  return PRIMARY_BADGE[state] || PRIMARY_BADGE.checking;
}

function borderFor(state, isPrimary) {
  if (!isPrimary) return 'border-gray-200 bg-white';
  if (state === 'running') return 'border-emerald-300 bg-emerald-50/40';
  if (state === 'offline') return 'border-rose-200 bg-rose-50/30';
  if (state === 'not_running') return 'border-amber-300 bg-amber-50/30';
  return 'border-slate-200 bg-white';
}

// ── component ────────────────────────────────────────────────────────────────

export default function BackendCard({ entry, capability, probe, isPrimary, position, onProbe, onSetPrimary, onMove }) {
  const [open, setOpen] = useState(false);

  const RuntimeIcon = runtimeIcon(entry.runtime);
  const headline = headlineMetric(entry, capability);
  const cost = costInfo(entry);
  const state = runState(entry, probe);
  const dot = dotFor(state, probe);
  const badge = isPrimary ? primaryBadge(state, entry) : null;
  const dim = entry.status === 'install_failed';
  const planned = entry.status === 'planned' || entry.status === 'install_failed';

  return (
    <div className={`rounded-lg border ${borderFor(state, isPrimary)} ${dim ? 'opacity-60' : ''}`}>
      {/* collapsed header row */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot.cls}`}
          role="img"
          aria-label={dot.title}
          title={dot.title}
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          title={open ? 'Hide details' : 'Show details'}
        >
          <span className="truncate text-sm font-semibold text-gray-900">{shortName(entry)}</span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
            <RuntimeIcon className="h-3 w-3" /> {locTag(entry.runtime)}
          </span>
          {headline && <span className="shrink-0 text-[11px] font-medium text-gray-500">{headline}</span>}
          <span className={`shrink-0 text-[10px] font-medium ${cost.cls}`}>{cost.short}</span>
        </button>

        {badge && (
          <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
            {badge.text}
          </span>
        )}
        {!isPrimary && (entry.status === 'planned' || entry.status === 'install_failed') && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
            {entry.status === 'planned' ? 'planned' : 'unavailable'}
          </span>
        )}
        {entry.degraded && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
            degraded
          </span>
        )}

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100"
          aria-expanded={open}
          aria-label={open ? 'Hide details' : 'Show details'}
          title={open ? 'Hide details' : 'Show details'}
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* expanded details + actions */}
      {open && (
        <div className="space-y-2 border-t border-gray-100 px-2.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-gray-500" title={entry.model}>
              {entry.model}
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
              <RuntimeIcon className="h-3 w-3" /> {entry.runtime_label || entry.runtime}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <Metric label="Speed">
              {(() => {
                const s = speedDetail(entry, capability);
                return (
                  <>
                    <span className="font-medium text-gray-800">{s.seed || '—'}</span>
                    {s.seed && <span className="ml-1 text-[10px] text-gray-400">{s.seedLabel}</span>}
                    {s.live && (
                      <div className="text-emerald-700">
                        {s.live}
                        <span className="ml-1 text-[10px] text-emerald-600/70">live · {s.samples}</span>
                      </div>
                    )}
                  </>
                );
              })()}
            </Metric>
            <Metric label="Accuracy">
              <span className="font-medium text-gray-800">{accuracyText(entry, capability) || '—'}</span>
            </Metric>
            <Metric label="Cost">
              <span className={`font-medium ${cost.cls}`}>{cost.full}</span>
            </Metric>
          </div>

          {capability === 'stt' && entry.languages && (
            <div className="text-[11px] leading-snug" title={entry.languages.note}>
              <span className="text-gray-400">Languages: </span>
              {entry.languages.indic && entry.languages.indic.length ? (
                <span className="text-gray-700">
                  {entry.languages.total} langs · Indic: {entry.languages.indic.join(', ')}
                </span>
              ) : (
                <span className="text-amber-700">
                  {entry.languages.total === 1 ? 'English only' : `${entry.languages.total} langs`} · no Indic
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-1 pt-0.5">
            <button
              type="button"
              onClick={() => onProbe && onProbe(capability, entry.id)}
              className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              {probe && probe.checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Probe
            </button>
            {!isPrimary && (
              <button
                type="button"
                onClick={() => onSetPrimary && onSetPrimary(entry)}
                disabled={dim}
                className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                <Star className="h-3 w-3" /> Make primary
              </button>
            )}
            {position && (
              <span className="flex">
                <button
                  type="button"
                  onClick={() => onMove && onMove(-1)}
                  disabled={position.index <= 0}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                  title="Higher fallback priority"
                  aria-label="Higher fallback priority"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onMove && onMove(1)}
                  disabled={position.index >= position.total - 1}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                  title="Lower fallback priority"
                  aria-label="Lower fallback priority"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>

          {(planned || state === 'offline' || (probe && probe.ok === null && probe.note)) && (
            <div className="rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
              {planned && entry.start_hint
                ? `To enable: ${entry.start_hint}`
                : probe && probe.error
                ? probe.error
                : probe && probe.note
                ? probe.note
                : entry.start_hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, children }) {
  return (
    <div>
      <div className="text-gray-400">{label}</div>
      <div>{children}</div>
    </div>
  );
}

Metric.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node,
};

BackendCard.propTypes = {
  entry: PropTypes.object.isRequired,
  capability: PropTypes.oneOf(['stt', 'diarization', 'llm']).isRequired,
  probe: PropTypes.object,
  isPrimary: PropTypes.bool,
  position: PropTypes.shape({ index: PropTypes.number, total: PropTypes.number }),
  onProbe: PropTypes.func,
  onSetPrimary: PropTypes.func,
  onMove: PropTypes.func,
};
