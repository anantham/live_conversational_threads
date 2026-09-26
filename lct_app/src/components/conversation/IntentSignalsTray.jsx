import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Ban, CheckCircle2, RefreshCw, Sparkles, X } from "lucide-react";

import {
  abandonIntentSignal,
  fetchIntentSignals,
  markIntentSignalReady,
} from "../../services/intentSignalsApi";

export default function IntentSignalsTray({ conversationId, enabled = true }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("idle");
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionState, setActionState] = useState({ signalId: "", action: "", error: "" });

  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    let cancelled = false;
    setState("loading");
    setError("");
    fetchIntentSignals(conversationId)
      .then((body) => {
        if (cancelled) return;
        setItems(Array.isArray(body.items) ? body.items : []);
        setState("ready");
        setActionState({ signalId: "", action: "", error: "" });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Intent signal lookup failed");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled, refreshKey]);

  const activeCount = items.length;
  const latest = useMemo(() => items[0] || null, [items]);
  if (!enabled || !conversationId) return null;
  if (state === "ready" && activeCount === 0 && !open) return null;

  async function handleLifecycle(signal, nextStatus) {
    if (!signal?.id || actionState.signalId) return;
    const action = nextStatus === "ready" ? "ready" : "abandon";
    setActionState({ signalId: signal.id, action, error: "" });
    try {
      const updated =
        nextStatus === "ready"
          ? await markIntentSignalReady(conversationId, signal.id)
          : await abandonIntentSignal(conversationId, signal.id);
      setItems((current) => {
        if (nextStatus === "abandoned") {
          return current.filter((item) => item.id !== signal.id);
        }
        return current.map((item) => (item.id === signal.id ? { ...item, ...updated } : item));
      });
      setActionState({ signalId: "", action: "", error: "" });
    } catch (err) {
      setActionState({
        signalId: signal.id,
        action: "",
        error: err?.message || "Intent signal update failed",
      });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={state === "loading"}
        className={`absolute left-4 bottom-20 z-30 inline-flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-md transition ${
          state === "error"
            ? "border-rose-200 bg-rose-50/95 text-rose-800"
            : "border-amber-200 bg-white/95 text-slate-700 hover:bg-amber-50"
        } ${state === "loading" ? "cursor-wait opacity-80" : "cursor-pointer"}`}
        aria-label={buttonLabel(state, activeCount)}
        title={state === "error" ? error : latest?.raw_text || ""}
      >
        <Sparkles size={14} className={state === "loading" ? "animate-pulse" : ""} />
        <span className="font-medium">{buttonLabel(state, activeCount)}</span>
      </button>

      {open && (
        <section
          className="absolute left-4 top-4 bottom-20 z-40 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl"
          aria-label="Intent signals"
        >
          <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">intent signals</div>
              <h2 className="text-sm font-semibold text-slate-900">
                {activeCount} {activeCount === 1 ? "signal" : "signals"}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                disabled={state === "loading"}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-wait disabled:opacity-50"
                aria-label="Refresh intent signals"
                title="Refresh"
              >
                <RefreshCw size={15} className={state === "loading" ? "animate-spin" : ""} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close intent signals"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {state === "error" ? (
              <div className="rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </div>
            ) : state === "loading" && activeCount === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">Loading…</div>
            ) : activeCount === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">No signals</div>
            ) : (
              <ul className="space-y-2.5">
                {items.map((signal) => (
                  <IntentSignalItem
                    key={signal.id}
                    signal={signal}
                    busyAction={actionState.signalId === signal.id ? actionState.action : ""}
                    actionError={actionState.signalId === signal.id ? actionState.error : ""}
                    actionsDisabled={Boolean(actionState.signalId)}
                    onMarkReady={() => handleLifecycle(signal, "ready")}
                    onAbandon={() => handleLifecycle(signal, "abandoned")}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </>
  );
}

IntentSignalsTray.propTypes = {
  conversationId: PropTypes.string,
  enabled: PropTypes.bool,
};

function IntentSignalItem({
  signal,
  busyAction = "",
  actionError = "",
  actionsDisabled = false,
  onMarkReady,
  onAbandon,
}) {
  const sightings = Array.isArray(signal.sightings) ? signal.sightings : [];
  const terminal = signal.status === "formalized" || signal.status === "abandoned";
  const ready = signal.status === "ready";
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-medium leading-snug text-slate-900">
          {signal.raw_text}
        </div>
        {typeof signal.detection_confidence === "number" && (
          <span className="shrink-0 font-mono text-[10px] text-slate-400">
            {Math.round(signal.detection_confidence * 100)}%
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
        <Badge label={signal.status} />
        <Badge label={signal.speaker_id} />
        {signal.sighting_count > 1 ? <Badge label={`${signal.sighting_count} sightings`} /> : null}
      </div>
      {signal.context_window && (
        <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-slate-600">
          {signal.context_window}
        </p>
      )}
      {!terminal && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onMarkReady}
            disabled={actionsDisabled || ready}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-200 px-2 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={`Mark intent signal ready: ${signal.raw_text}`}
            title={ready ? "Already ready" : "Mark ready"}
          >
            <CheckCircle2 size={13} />
            {busyAction === "ready" ? "Saving" : "Ready"}
          </button>
          <button
            type="button"
            onClick={onAbandon}
            disabled={actionsDisabled}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={`Abandon intent signal: ${signal.raw_text}`}
            title="Abandon"
          >
            <Ban size={13} />
            {busyAction === "abandon" ? "Saving" : "Abandon"}
          </button>
        </div>
      )}
      {actionError && (
        <div className="mt-2 rounded-md border border-rose-100 bg-rose-50 px-2 py-1.5 text-xs text-rose-700">
          {actionError}
        </div>
      )}
      {sightings.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">sightings</div>
          <ul className="space-y-1.5">
            {sightings.slice(0, 3).map((sighting) => (
              <li key={sighting.id} className="text-xs leading-relaxed text-slate-600">
                {sighting.context_note || formatTime(sighting.sighted_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

IntentSignalItem.propTypes = {
  signal: PropTypes.shape({
    id: PropTypes.string.isRequired,
    raw_text: PropTypes.string.isRequired,
    context_window: PropTypes.string,
    speaker_id: PropTypes.string,
    status: PropTypes.string,
    sighting_count: PropTypes.number,
    detection_confidence: PropTypes.number,
    sightings: PropTypes.arrayOf(PropTypes.object),
  }).isRequired,
  busyAction: PropTypes.string,
  actionError: PropTypes.string,
  actionsDisabled: PropTypes.bool,
  onMarkReady: PropTypes.func.isRequired,
  onAbandon: PropTypes.func.isRequired,
};

function Badge({ label }) {
  if (!label) return null;
  return (
    <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
      {label}
    </span>
  );
}

Badge.propTypes = {
  label: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
};

function buttonLabel(state, count) {
  if (state === "loading") return "Loading signals";
  if (state === "error") return "Signal lookup failed";
  if (count === 1) return "1 signal";
  return `${count} signals`;
}

function formatTime(iso) {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
