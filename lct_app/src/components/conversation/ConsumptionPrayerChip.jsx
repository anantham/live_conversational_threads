/**
 * ConsumptionPrayerChip — floating chip rendered bottom-right of the live
 * conversation pane. Hidden when there are no matches; shows a count + label
 * when results are present. Tap to open the drawer.
 *
 * Per the design picked in session: "Floating chip, bottom-right" — maximum
 * restraint, invisible until there's a match.
 *
 * Loading state: pulses dharma-tinted to signal "looking" while a manual
 * trigger is in flight. Error state: surfaces in a soft tone so a 502 from
 * IndrasNet doesn't read as scary.
 */

import PropTypes from "prop-types";

const STATE_TONE = {
  idle: "bg-white/95 backdrop-blur border-gray-200 text-gray-700 hover:bg-white",
  loading: "bg-amber-50/95 backdrop-blur border-amber-200 text-amber-800",
  error: "bg-rose-50/95 backdrop-blur border-rose-200 text-rose-800",
};

export default function ConsumptionPrayerChip({
  state = "idle", // "idle" | "loading" | "error"
  itemCount = 0,
  contactName = "",
  errorMessage = "",
  onOpen,
}) {
  const isLoading = state === "loading";
  const isError = state === "error";
  const hasItems = itemCount > 0;

  // Hide entirely when idle with no items — chip is "invisible until needed"
  if (state === "idle" && !hasItems) return null;

  const tone = STATE_TONE[state] || STATE_TONE.idle;

  let label;
  if (isLoading) {
    label = contactName ? `looking up ${contactName}…` : "looking up…";
  } else if (isError) {
    label = errorMessage || "couldn't reach pending list";
  } else {
    const noun = itemCount === 1 ? "thread" : "threads";
    label = contactName
      ? `${itemCount} pending ${noun} · ${contactName}`
      : `${itemCount} pending ${noun}`;
  }

  return (
    <button
      type="button"
      onClick={hasItems && !isLoading ? onOpen : undefined}
      disabled={isLoading || !hasItems}
      className={`fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-md transition-all ${tone} ${
        isLoading ? "cursor-wait" : hasItems ? "cursor-pointer" : "cursor-default"
      } ${isLoading ? "animate-pulse" : ""}`}
      aria-label={label}
      title={
        isError
          ? errorMessage
          : hasItems
          ? "Open pending discussions drawer"
          : ""
      }
    >
      {/* Dot signal */}
      <span
        className={`h-2 w-2 rounded-full ${
          isLoading
            ? "bg-amber-500"
            : isError
            ? "bg-rose-500"
            : "bg-emerald-500"
        }`}
        aria-hidden="true"
      />
      <span className="font-medium">{label}</span>
      {hasItems && !isError && (
        <span className="text-gray-400" aria-hidden="true">
          ›
        </span>
      )}
    </button>
  );
}

ConsumptionPrayerChip.propTypes = {
  state: PropTypes.oneOf(["idle", "loading", "error"]),
  itemCount: PropTypes.number,
  contactName: PropTypes.string,
  errorMessage: PropTypes.string,
  onOpen: PropTypes.func,
};
