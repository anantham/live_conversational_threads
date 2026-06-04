import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';

import BackendCard from './BackendCard';
import { isServing } from './backendState';

/**
 * One capability lane (STT / Diarization / LLM). Minimal by default: the selected
 * primary as one compact card, alternatives collapsed behind a toggle, and — when
 * the selected backend isn't actually serving — an honest "Serving now" banner.
 *
 * "Serving" is derived from the SAME probe-aware rule the card badge uses
 * (backendState.isServing), so the banner and the badge can never contradict.
 */
export default function CapabilityLane({
  title,
  subtitle,
  icon: Icon,
  capability,
  entries = [],
  primaryId,
  effectiveId,
  probes = {},
  reorderable = false,
  advancedLabel,
  nothingRunningHint,
  onProbe,
  onSetPrimary,
  onMove,
  onAdvanced,
}) {
  const [showAlts, setShowAlts] = useState(false);

  const { primary, alternatives, effective } = useMemo(() => {
    const p = entries.find((e) => e.id === primaryId) || entries.find((e) => e.is_active) || entries[0] || null;
    const eff = effectiveId ? entries.find((e) => e.id === effectiveId) : null;
    return { primary: p, alternatives: entries.filter((e) => e !== p), effective: eff };
  }, [entries, primaryId, effectiveId]);

  const probeFor = (entry) => probes[`${capability}:${entry.id}`];
  // Probe-aware: only KNOWN-down primaries trigger the fallback banner.
  const primaryServing = primary && isServing(primary, probeFor(primary));
  const showServingBanner = !primaryServing && effective && effective.id !== (primary && primary.id);
  const showNothingRunning = !primaryServing && !effective;

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="flex items-start gap-2.5">
          {Icon && (
            <span className="mt-0.5 rounded-lg bg-gray-100 p-2 text-gray-600">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            <p className="text-[11px] text-gray-500">{subtitle}</p>
          </div>
        </div>
        {onAdvanced && (
          <button
            type="button"
            onClick={onAdvanced}
            className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] font-medium text-blue-600 hover:text-blue-700"
          >
            {advancedLabel || 'Advanced'} <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </header>

      <div className="space-y-2 p-3">
        {primary && (
          <BackendCard
            key={primary.id}
            entry={primary}
            capability={capability}
            probe={probeFor(primary)}
            isPrimary
            onProbe={onProbe}
            onSetPrimary={onSetPrimary}
          />
        )}

        {showServingBanner && (
          <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span>
              Serving now: <strong>{String(effective.display_name).split(' (')[0]}</strong>
              {effective.degraded ? ' (degraded)' : ''} — the selected backend isn’t running.
            </span>
          </div>
        )}
        {showNothingRunning && (
          <div className="flex items-center gap-1.5 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span>{nothingRunningHint || 'Nothing running for this capability right now.'}</span>
          </div>
        )}

        {alternatives.length > 0 && (
          <div className="pt-0.5">
            <button
              type="button"
              onClick={() => setShowAlts((s) => !s)}
              aria-expanded={showAlts}
              className="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50"
            >
              {showAlts ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Alternatives ({alternatives.length})
            </button>
            {showAlts && (
              <div className="space-y-2 pt-1">
                {alternatives.map((entry, index) => (
                  <BackendCard
                    key={entry.id}
                    entry={entry}
                    capability={capability}
                    probe={probeFor(entry)}
                    isPrimary={false}
                    position={reorderable ? { index, total: alternatives.length } : null}
                    onProbe={onProbe}
                    onSetPrimary={onSetPrimary}
                    onMove={reorderable ? (dir) => onMove && onMove(entry.id, dir) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

CapabilityLane.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  icon: PropTypes.elementType,
  capability: PropTypes.oneOf(['stt', 'diarization', 'llm']).isRequired,
  entries: PropTypes.array,
  primaryId: PropTypes.string,
  effectiveId: PropTypes.string,
  probes: PropTypes.object,
  reorderable: PropTypes.bool,
  advancedLabel: PropTypes.string,
  nothingRunningHint: PropTypes.string,
  onProbe: PropTypes.func,
  onSetPrimary: PropTypes.func,
  onMove: PropTypes.func,
  onAdvanced: PropTypes.func,
};
