import PropTypes from "prop-types";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ellipsis,
  Map,
} from "lucide-react";

function navigationButtonClass(disabled) {
  return `inline-flex h-12 w-12 items-center justify-center rounded-full border text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
    disabled
      ? "border-slate-100 bg-slate-50 text-slate-300"
      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100"
  }`;
}

export function MobileDeckHeader({ levelInfo, onMore, onShowMap, position, title, total }) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white/90 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <button
        type="button"
        onClick={onShowMap}
        aria-label="Open conversation map"
        title="Open conversation map"
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <Map aria-hidden="true" className="h-[18px] w-[18px]" />
      </button>
      <div className="min-w-0 flex-1 text-center">
        <h1 className="truncate text-sm font-semibold tracking-[-0.02em] text-slate-800">{title}</h1>
        <p className="mt-0.5 text-[11px] capitalize tabular-nums text-slate-500">
          {levelInfo.plural} · {position || 0} of {total || 0}
        </p>
      </div>
      <button
        type="button"
        onClick={onMore}
        aria-label="More conversation options"
        title="More options"
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <Ellipsis aria-hidden="true" className="h-5 w-5" />
      </button>
    </header>
  );
}

MobileDeckHeader.propTypes = {
  levelInfo: PropTypes.shape({ plural: PropTypes.string.isRequired }).isRequired,
  onMore: PropTypes.func.isRequired,
  onShowMap: PropTypes.func.isRequired,
  position: PropTypes.number.isRequired,
  title: PropTypes.string.isRequired,
  total: PropTypes.number.isRequired,
};

export function MobileDeckNavigation({ navigate, snapshot }) {
  return (
    <nav aria-label="Conversation deck navigation" className="mt-3 flex shrink-0 items-center justify-center gap-2">
      <button
        type="button"
        onClick={() => navigate("up")}
        aria-label="Move to a higher level of abstraction"
        className={navigationButtonClass(!snapshot.canUp)}
      >
        <ArrowUp aria-hidden="true" className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={() => navigate("previous")}
        aria-label={`Previous ${snapshot.levelInfo.singular}`}
        className={navigationButtonClass(!snapshot.canPrevious)}
      >
        <ArrowLeft aria-hidden="true" className="h-5 w-5" />
      </button>
      <span className="min-w-14 text-center text-xs font-medium tabular-nums text-slate-500" aria-live="polite">
        {snapshot.position || 0} / {snapshot.total || 0}
      </span>
      <button
        type="button"
        onClick={() => navigate("next")}
        aria-label={`Next ${snapshot.levelInfo.singular}`}
        className={navigationButtonClass(!snapshot.canNext)}
      >
        <ArrowRight aria-hidden="true" className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={() => navigate("down")}
        aria-label="Drill into a finer level of detail"
        className={navigationButtonClass(!snapshot.canDown)}
      >
        <ArrowDown aria-hidden="true" className="h-5 w-5" />
      </button>
    </nav>
  );
}

MobileDeckNavigation.propTypes = {
  navigate: PropTypes.func.isRequired,
  snapshot: PropTypes.shape({
    canDown: PropTypes.bool.isRequired,
    canNext: PropTypes.bool.isRequired,
    canPrevious: PropTypes.bool.isRequired,
    canUp: PropTypes.bool.isRequired,
    levelInfo: PropTypes.shape({ singular: PropTypes.string.isRequired }).isRequired,
    position: PropTypes.number.isRequired,
    total: PropTypes.number.isRequired,
  }).isRequired,
};
