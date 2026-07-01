import { useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, ChevronUp, GripVertical, Star } from "lucide-react";

// One ranked list per capability: the top item runs first (primary); the rest
// are the fallback order, tried top-to-bottom. Reordering does both jobs at
// once. Drag to reorder, with up/down chevrons as the keyboard-accessible
// equivalent. Disabled engines (not built, or cloud without a key) stay in the
// list, greyed, with a reason, rather than hiding in a separate place.
//
// Presentational only: it emits the new id order via onReorder and never
// mutates settings itself, so the capability section owns the write semantics.
export default function RankedEngineList({ items, onReorder, showPrimary = true }) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  const ids = items.map((it) => it.id);

  const move = (fromId, toId) => {
    if (fromId === toId) return;
    if (!ids.includes(fromId) || !ids.includes(toId)) return;
    // Consistent semantics regardless of drag direction: drop places the item
    // immediately BEFORE the row it was dropped on. (The naive splice-after-
    // removal shifts indices when moving down, giving asymmetric results.)
    const without = ids.filter((id) => id !== fromId);
    const targetIdx = without.indexOf(toId);
    if (targetIdx < 0) return;
    without.splice(targetIdx, 0, fromId);
    onReorder(without);
  };

  const nudge = (id, dir) => {
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next);
  };

  return (
    <ul className="space-y-2">
      {items.map((it, index) => {
        const isPrimary = showPrimary && index === 0;
        const isDragging = dragId === it.id;
        const isOver = overId === it.id && dragId && dragId !== it.id;
        return (
          <li
            key={it.id}
            draggable={!it.disabled}
            onDragStart={() => setDragId(it.id)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(it.id);
            }}
            onDrop={() => {
              if (dragId) move(dragId, it.id);
              setDragId(null);
              setOverId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
              it.disabled
                ? "border-gray-200 bg-gray-50 opacity-60"
                : isPrimary
                ? "border-emerald-200 bg-emerald-50/50"
                : "border-gray-200 bg-white"
            } ${isDragging ? "opacity-40" : ""} ${isOver ? "ring-2 ring-gray-300" : ""}`}
          >
            <span
              className={`shrink-0 ${it.disabled ? "text-gray-300" : "cursor-grab text-gray-400"}`}
              aria-hidden="true"
              title={it.disabled ? undefined : "Drag to reorder"}
            >
              <GripVertical className="h-4 w-4" />
            </span>

            <span className="w-4 shrink-0 text-center text-xs font-medium text-gray-400">
              {index + 1}
            </span>

            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                it.status === "ok" ? "bg-emerald-500" : it.status === "off" ? "bg-rose-500" : "bg-gray-300"
              }`}
              aria-hidden="true"
            />

            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-gray-900">{it.name}</span>
                {it.tag ? (
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                    {it.tag}
                  </span>
                ) : null}
                {isPrimary && !it.disabled ? (
                  <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    PRIMARY
                  </span>
                ) : null}
              </span>
              {it.meta ? <span className="mt-0.5 block text-[11px] text-gray-500">{it.meta}</span> : null}
              {it.disabled && it.disabledReason ? (
                <span className="mt-0.5 block text-[11px] text-amber-700">{it.disabledReason}</span>
              ) : null}
            </span>

            {!it.disabled ? (
              <span className="flex shrink-0 items-center">
                {showPrimary && !isPrimary ? (
                  <button
                    type="button"
                    onClick={() => onReorder([it.id, ...ids.filter((x) => x !== it.id)])}
                    className="mr-1 inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                    title="Make primary"
                  >
                    <Star className="h-3 w-3" /> Make primary
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => nudge(it.id, -1)}
                  disabled={index === 0}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                  aria-label={`Move ${it.name} up`}
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => nudge(it.id, 1)}
                  disabled={index === items.length - 1}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                  aria-label={`Move ${it.name} down`}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

RankedEngineList.propTypes = {
  items: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      tag: PropTypes.string,
      meta: PropTypes.string,
      status: PropTypes.oneOf(["ok", "off", "idle"]),
      disabled: PropTypes.bool,
      disabledReason: PropTypes.string,
    }),
  ).isRequired,
  onReorder: PropTypes.func.isRequired,
  showPrimary: PropTypes.bool,
};
