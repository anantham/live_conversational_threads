import PropTypes from "prop-types";

const STATE_TONE = {
  idle: "bg-white/95 backdrop-blur border-slate-200 text-slate-700 hover:bg-white",
  loading: "bg-blue-50/95 backdrop-blur border-blue-200 text-blue-800",
  error: "bg-rose-50/95 backdrop-blur border-rose-200 text-rose-800",
};

export default function PrayerCardChip({
  state = "idle",
  cardCount = 0,
  latestEvent = null,
  errorMessage = "",
  onOpen,
}) {
  const isLoading = state === "loading";
  const isError = state === "error";
  const hasCards = cardCount > 0;

  if (state === "idle" && !hasCards) return null;

  const tone = STATE_TONE[state] || STATE_TONE.idle;
  const latestCard = latestEvent?.cards?.[0] || null;

  let label = "prayer card";
  if (isLoading) {
    label = "routing prayer...";
  } else if (isError) {
    label = errorMessage || "prayer routing failed";
  } else if (latestCard?.status === "executed") {
    label = cardCount === 1 ? "fetch results ready" : `${cardCount} prayer cards`;
  } else if (latestCard?.status === "captured") {
    label = cardCount === 1 ? "fetch captured" : `${cardCount} prayer cards`;
  } else if (latestCard?.status === "error") {
    label = "fetch card needs attention";
  } else if (hasCards) {
    label = `${cardCount} prayer ${cardCount === 1 ? "card" : "cards"}`;
  }

  return (
    <button
      type="button"
      onClick={hasCards && !isLoading ? onOpen : undefined}
      disabled={isLoading || !hasCards}
      className={`fixed bottom-20 right-6 z-40 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-md transition-all ${tone} ${
        isLoading ? "cursor-wait animate-pulse" : hasCards ? "cursor-pointer" : "cursor-default"
      }`}
      aria-label={label}
      title={isError ? errorMessage : hasCards ? "Open prayer cards" : ""}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          isLoading
            ? "bg-blue-500"
            : isError || latestCard?.status === "error"
              ? "bg-rose-500"
              : "bg-emerald-500"
        }`}
        aria-hidden="true"
      />
      <span className="font-medium">{label}</span>
      {hasCards && !isError && (
        <span className="text-slate-400" aria-hidden="true">
          &rsaquo;
        </span>
      )}
    </button>
  );
}

PrayerCardChip.propTypes = {
  state: PropTypes.oneOf(["idle", "loading", "error"]),
  cardCount: PropTypes.number,
  latestEvent: PropTypes.shape({
    cards: PropTypes.arrayOf(PropTypes.object),
  }),
  errorMessage: PropTypes.string,
  onOpen: PropTypes.func,
};
