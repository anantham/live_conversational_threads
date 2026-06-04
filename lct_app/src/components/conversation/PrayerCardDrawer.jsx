import PropTypes from "prop-types";

export default function PrayerCardDrawer({
  open,
  events = [],
  onClose,
}) {
  if (!open) return null;

  const cardCount = events.reduce((count, event) => count + (event.cards?.length || 0), 0);
  const latestDecision = events[0]?.decision || null;

  return (
    <>
      <button
        type="button"
        aria-label="Close prayer cards"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px] cursor-default"
      />

      <aside
        role="dialog"
        aria-label="Prayer cards"
        className="fixed top-0 right-0 z-50 h-full w-[420px] max-w-[92vw] bg-white shadow-2xl border-l border-slate-200 flex flex-col animate-slideIn"
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <div className="text-[10px] tracking-wide uppercase text-slate-500">
              prayer cards
            </div>
            <h2 className="text-lg font-semibold text-slate-900">
              {cardCount} {cardCount === 1 ? "card" : "cards"}
            </h2>
            {latestDecision && (
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
                <Badge label={latestDecision.urgency} />
                <Badge label={latestDecision.surface_mode} />
                {latestDecision.auto_actuate ? <Badge label="auto" /> : null}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-xl leading-none px-2"
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {events.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-4">
              {events.map((event) => (
                <PrayerEvent key={event.event_id} event={event} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

PrayerCardDrawer.propTypes = {
  open: PropTypes.bool,
  events: PropTypes.arrayOf(PropTypes.object),
  onClose: PropTypes.func.isRequired,
};

function PrayerEvent({ event }) {
  const cards = Array.isArray(event.cards) ? event.cards : [];
  return (
    <section className="space-y-2.5">
      <div className="text-[10px] tracking-wide uppercase text-slate-400">
        {formatTime(event.triggered_at || event.detected_at)}
      </div>
      {event.selected_text && (
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs italic text-slate-600">
          &ldquo;{event.selected_text}&rdquo;
        </div>
      )}
      {cards.map((card, idx) => (
        <PrayerCard key={card.card_id || `${event.event_id}-${idx}`} card={card} />
      ))}
    </section>
  );
}

PrayerEvent.propTypes = {
  event: PropTypes.shape({
    event_id: PropTypes.string,
    cards: PropTypes.arrayOf(PropTypes.object),
    selected_text: PropTypes.string,
    triggered_at: PropTypes.string,
    detected_at: PropTypes.string,
  }).isRequired,
};

function PrayerCard({ card }) {
  const results = Array.isArray(card.results) ? card.results : [];
  return (
    <article className="rounded-lg border border-slate-200 px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">
            {card.title || card.prayer_type || "Prayer"}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
            <Badge label={card.prayer_type || card.card_type} />
            <Badge label={card.status} tone={statusTone(card.status)} />
            <Badge label={card.urgency} />
            <Badge label={card.surface_mode} />
          </div>
        </div>
        {typeof card.confidence === "number" && (
          <span className="shrink-0 text-[10px] font-mono text-slate-400">
            {Math.round(card.confidence * 100)}%
          </span>
        )}
      </div>

      {card.query && (
        <div className="mt-2 text-xs text-slate-700 leading-relaxed">
          {card.query}
        </div>
      )}

      {card.error && (
        <div className="mt-2 rounded-md border border-rose-100 bg-rose-50 px-2.5 py-2 text-xs text-rose-700">
          {card.error}
        </div>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {results.map((result, idx) => (
            <FetchResult key={result.id || `${card.card_id}-result-${idx}`} result={result} />
          ))}
        </ul>
      )}
    </article>
  );
}

PrayerCard.propTypes = {
  card: PropTypes.shape({
    card_id: PropTypes.string,
    card_type: PropTypes.string,
    prayer_type: PropTypes.string,
    title: PropTypes.string,
    query: PropTypes.string,
    status: PropTypes.string,
    urgency: PropTypes.string,
    surface_mode: PropTypes.string,
    confidence: PropTypes.number,
    error: PropTypes.string,
    results: PropTypes.arrayOf(PropTypes.object),
  }).isRequired,
};

function FetchResult({ result }) {
  return (
    <li className="rounded-md border border-slate-100 bg-slate-50 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-xs font-medium text-slate-800 truncate">
          {result.title || result.source_path || result.source_id || "Memory"}
        </div>
        {typeof result.score === "number" && (
          <span className="shrink-0 text-[10px] font-mono text-slate-400">
            {result.score.toFixed(2)}
          </span>
        )}
      </div>
      {result.snippet && (
        <div className="mt-1 text-xs text-slate-600 leading-relaxed line-clamp-4">
          {result.snippet}
        </div>
      )}
      {result.why_relevant && (
        <div className="mt-1 text-[10px] text-slate-500">
          {result.why_relevant}
        </div>
      )}
    </li>
  );
}

FetchResult.propTypes = {
  result: PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    title: PropTypes.string,
    source_id: PropTypes.string,
    source_path: PropTypes.string,
    snippet: PropTypes.string,
    score: PropTypes.number,
    why_relevant: PropTypes.string,
  }).isRequired,
};

function Badge({ label, tone = "slate" }) {
  if (!label) return null;
  const tones = {
    slate: "border-slate-200 bg-slate-50 text-slate-500",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return (
    <span className={`rounded-full border px-1.5 py-0.5 ${tones[tone] || tones.slate}`}>
      {label}
    </span>
  );
}

Badge.propTypes = {
  label: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  tone: PropTypes.oneOf(["slate", "green", "amber", "rose"]),
};

function EmptyState() {
  return (
    <div className="text-center py-12 px-2">
      <div className="text-sm font-medium text-slate-700 mb-1">
        No prayer cards
      </div>
      <div className="text-xs text-slate-500">
        Captured prayers will appear here when IndrasNet returns a card.
      </div>
    </div>
  );
}

function statusTone(status) {
  if (status === "executed") return "green";
  if (status === "captured") return "amber";
  if (status === "error") return "rose";
  return "slate";
}

function formatTime(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
