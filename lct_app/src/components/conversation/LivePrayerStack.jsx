import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Search, Link2, X, ChevronDown } from "lucide-react";

/**
 * LivePrayerStack — the ambient surface for AUTO live-prayer cards (the
 * `prayer_card` WS event). Calm by doctrine (ADR-011): a quiet lantern dot that
 * breathes amber when something fresh has been found — no sound, no auto-open.
 * Click to open a stack; the newest card sits on top and pushes older ones down
 * (purely positional — never time-decayed, because STT + detection + fact-check
 * take seconds). Swipe a card left (or ✕ / ←) to dismiss it, Tinder-style.
 *
 * Distinct from PrayerCardChip/Drawer (the manual selection→fetch path); this one
 * is fed by the live detector and is additive.
 */

const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const VERDICT_TONE = {
  SUPPORTED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REFUTED: "bg-rose-50 text-rose-700 border-rose-200",
  PARTLY: "bg-amber-50 text-amber-700 border-amber-200",
  UNVERIFIABLE: "bg-slate-100 text-slate-500 border-slate-200",
};

const VISIBLE_LIMIT = 5;
const DISMISS_THRESHOLD = 80; // px of leftward drag to dismiss

export default function LivePrayerStack({ cards = [], onDismiss }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const seenRef = useRef(new Set());
  const [, forceTick] = useState(0);
  const dotRef = useRef(null);

  const unseen = useMemo(
    () => cards.filter((c) => !seenRef.current.has(c.card_id)).length,
    // forceTick keeps this honest after we mutate the seen set
    [cards, forceTick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // While open, everything visible counts as seen.
  useEffect(() => {
    if (!open) return;
    cards.forEach((c) => seenRef.current.add(c.card_id));
    forceTick((n) => n + 1);
  }, [open, cards]);

  // The lantern breathes amber only while there's something unseen.
  useEffect(() => {
    const el = dotRef.current;
    if (!el || PREFERS_REDUCED_MOTION) return undefined;
    if (unseen <= 0 || open) return undefined;
    const anim = el.animate(
      [{ opacity: 0.5, transform: "scale(0.92)" }, { opacity: 1, transform: "scale(1)" }],
      { duration: 1600, direction: "alternate", iterations: Infinity, easing: "ease-in-out" },
    );
    return () => anim.cancel();
  }, [unseen, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!cards.length) return null;

  const visible = showAll ? cards : cards.slice(0, VISIBLE_LIMIT);
  const hidden = cards.length - visible.length;

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
      {open && (
        <div
          className="flex w-[340px] max-w-[calc(100vw-3rem)] flex-col-reverse gap-2"
          role="list"
          aria-label="Live prayer cards"
        >
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="self-center rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-xs text-slate-500 shadow-sm backdrop-blur transition-colors hover:text-slate-700"
            >
              + {hidden} earlier
            </button>
          )}
          {visible.map((card, i) => (
            <PrayerCardItem
              key={card.card_id}
              card={card}
              depth={i}
              onDismiss={() => onDismiss?.(card.card_id)}
            />
          ))}
        </div>
      )}

      <button
        ref={dotRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          open
            ? "Hide prayer cards"
            : `${cards.length} prayer ${cards.length === 1 ? "card" : "cards"}${unseen ? `, ${unseen} new` : ""}`
        }
        aria-expanded={open}
        className="relative flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white/95 shadow-md backdrop-blur transition-colors hover:bg-white"
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${unseen && !open ? "bg-amber-500" : "bg-slate-300"}`}
          aria-hidden="true"
        />
        {unseen > 0 && !open && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
            {unseen}
          </span>
        )}
      </button>
    </div>
  );
}

function PrayerCardItem({ card, depth, onDismiss }) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const startX = useRef(0);

  // Older cards (further down the stack) recede: gently dimmer + smaller.
  const recede = Math.min(depth, 3);
  const restOpacity = leaving ? 0 : 1 - recede * 0.12;
  const restScale = 1 - recede * 0.02;

  const beginDismiss = () => {
    if (leaving) return;
    setLeaving(true);
    if (PREFERS_REDUCED_MOTION) {
      onDismiss();
      return;
    }
    window.setTimeout(onDismiss, 220);
  };

  const onPointerDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX.current = e.clientX;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    setDragX(Math.min(0, e.clientX - startX.current)); // left-only
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    if (dragX <= -DISMISS_THRESHOLD) beginDismiss();
    else setDragX(0);
  };

  const translate = leaving ? -420 : dragX;
  const opacity = leaving ? 0 : dragging ? Math.max(0.4, 1 + dragX / 240) : restOpacity;

  return (
    <div
      role="listitem"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "Backspace" || e.key === "Delete") beginDismiss();
      }}
      style={{
        transform: `translateX(${translate}px) scale(${dragging ? 1 : restScale})`,
        opacity,
        transition: dragging ? "none" : "transform 220ms cubic-bezier(0.22,1,0.36,1), opacity 220ms ease-out",
        touchAction: "pan-y",
      }}
      className="group relative cursor-grab touch-pan-y rounded-lg border border-slate-200 bg-white p-3 shadow-sm active:cursor-grabbing"
    >
      <button
        type="button"
        onClick={beginDismiss}
        aria-label="Dismiss card"
        className="absolute right-1.5 top-1.5 rounded p-1 text-slate-300 opacity-0 transition-opacity hover:text-slate-500 focus:opacity-100 group-hover:opacity-100"
      >
        <X size={13} aria-hidden="true" />
      </button>
      {card.card_type === "factcheck" ? (
        <FactCheckBody card={card} />
      ) : (
        <FetchBody card={card} />
      )}
    </div>
  );
}

function FactCheckBody({ card }) {
  const v = card.verdict || {};
  const verdict = String(v.verdict || "UNVERIFIABLE").toUpperCase();
  const tone = VERDICT_TONE[verdict] || VERDICT_TONE.UNVERIFIABLE;
  const grounded = v.grounding === "grounded";
  return (
    <div className="pr-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
          {verdict.toLowerCase()}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-[11px] ${grounded ? "text-slate-500" : "text-slate-400"}`}
          title={grounded ? "Verified against your own notes / past conversations" : "From the model's general knowledge — not checked against your data"}
        >
          {grounded && <Link2 size={11} aria-hidden="true" />}
          {grounded ? "grounded" : "model knowledge"}
        </span>
      </div>
      <p className="text-sm font-medium leading-snug text-slate-800">{card.claim}</p>
      {v.reason && <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{v.reason}</p>}
      {grounded && Array.isArray(v.evidence) && v.evidence.length > 0 && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          {v.evidence.length} source{v.evidence.length === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

function FetchBody({ card }) {
  const results = Array.isArray(card.results) ? card.results : [];
  const top = results.slice(0, 3);
  const more = results.length - top.length;
  return (
    <div className="pr-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        <Search size={12} aria-hidden="true" />
        <span>fetch</span>
      </div>
      <p className="text-sm font-medium leading-snug text-slate-800">{card.query}</p>
      {card.status === "error" ? (
        <p className="mt-1 text-[13px] text-slate-400">couldn’t complete, tap to retry later</p>
      ) : top.length === 0 ? (
        <p className="mt-1 text-[13px] text-slate-400">no results found</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {top.map((r, i) => (
            <li key={r.id ?? r.source_id ?? i} className="text-[13px] leading-snug">
              <span className="text-slate-600">{(r.snippet || r.content || r.title || "").slice(0, 140)}</span>
              {r.source_type && <span className="ml-1 text-[11px] text-slate-400">· {r.source_type}</span>}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-400">
          <ChevronDown size={11} aria-hidden="true" /> {more} more
        </p>
      )}
    </div>
  );
}

const cardShape = PropTypes.shape({
  card_id: PropTypes.string.isRequired,
  card_type: PropTypes.oneOf(["fetch", "factcheck"]),
  status: PropTypes.string,
  query: PropTypes.string,
  claim: PropTypes.string,
  results: PropTypes.array,
  verdict: PropTypes.object,
});

LivePrayerStack.propTypes = {
  cards: PropTypes.arrayOf(cardShape),
  onDismiss: PropTypes.func,
};

PrayerCardItem.propTypes = { card: cardShape, depth: PropTypes.number, onDismiss: PropTypes.func };
FactCheckBody.propTypes = { card: cardShape };
FetchBody.propTypes = { card: cardShape };
