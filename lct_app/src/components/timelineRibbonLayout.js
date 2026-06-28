// Pure layout math for the multi-row TimelineRibbon (ADR-032 Part B).
//
// The ribbon shows conversation nodes as dots. ADR-032 wants:
//   - one ROW per thread (thread_id), most-active thread on top;
//   - dots positioned along the X-axis by `timestamp_start` (a real time-axis,
//     so dormant stretches show as gaps) — with an index-based fallback when
//     the artifact carries no timestamps (legacy / non-recorded conversations);
//   - return-to-thread shift: when a thread resumes after a gap longer than
//     RETURN_GAP_SECONDS, the first post-gap node is flagged so the view can
//     render it differently (deeper saturation + a "resumed" marker).
//
// All of this is pure so it can be unit-tested without React. The component
// consumes `buildRibbonLayout` and only does rendering + interaction.

export const DEFAULT_RAIL_START = 24; // px before the first dot
export const DEFAULT_DOT_SPACING = 54; // px between dots in index (fallback) mode
export const DEFAULT_RETURN_GAP_SECONDS = 60; // gap that counts as a thread "return"
export const UNGROUPED_KEY = "__ungrouped__";

/** Extract a numeric start-time (seconds) for a node, or null. Mirrors the
 *  field coverage the single-row ribbon and NodeDetail already use. */
export function getNodeTimestamp(node) {
  const metadata =
    node && typeof node.metadata === "object" && node.metadata ? node.metadata : null;
  const candidates = [
    node?.timestamp_start,
    node?.start_time,
    node?.timestamp,
    node?.time,
    node?.start,
    metadata?.timestamp_start,
    metadata?.start_time,
    metadata?.timestamp,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Stable grouping key for a node's thread. Nodes without a thread_id fall into
 *  a single "ungrouped" lane rather than vanishing. */
export function threadKey(node) {
  const raw = node?.thread_id;
  if (raw == null) return UNGROUPED_KEY;
  const s = String(raw).trim();
  return s === "" ? UNGROUPED_KEY : s;
}

/** Human label for a thread_id slug. ADR-032 §G uses path-style ids like
 *  "thread::vision" or "discussion-of-AI/sub-thread-on-privacy"; show the most
 *  specific segment, de-slugified. */
export function threadLabel(threadId) {
  if (threadId === UNGROUPED_KEY) return "ungrouped";
  const s = String(threadId);
  const afterColon = s.includes("::") ? s.slice(s.lastIndexOf("::") + 2) : s;
  const lastSeg = afterColon.includes("/")
    ? afterColon.slice(afterColon.lastIndexOf("/") + 1)
    : afterColon;
  const cleaned = lastSeg.replace(/[-_]+/g, " ").trim();
  return cleaned || String(threadId);
}

/**
 * Build the multi-row ribbon layout.
 *
 * @param {Array<object>} nodes  flat node list (already filtered by semantic level)
 * @param {object} [opts]
 * @param {number} [opts.railStart]
 * @param {number} [opts.dotSpacing]        spacing in index mode / target density in time mode
 * @param {number} [opts.minDotSpacing]     min px between consecutive dots in a row (time mode)
 * @param {number} [opts.returnGapSeconds]
 * @returns {{
 *   rows: Array<{ threadId: string, label: string, count: number,
 *                 nodes: Array<object & { x: number, isReturn: boolean, ts: (number|null) }> }>,
 *   totalWidth: number, timeBased: boolean, span: ({min:number,max:number}|null),
 *   pixelsPerSecond: (number|null)
 * }}
 */
export function buildRibbonLayout(nodes, opts = {}) {
  const {
    railStart = DEFAULT_RAIL_START,
    dotSpacing = DEFAULT_DOT_SPACING,
    minDotSpacing = 18,
    returnGapSeconds = DEFAULT_RETURN_GAP_SECONDS,
  } = opts;

  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  if (list.length === 0) {
    return { rows: [], totalWidth: 0, timeBased: false, span: null, pixelsPerSecond: null };
  }

  // Decide time-based vs index mode from the whole set.
  const times = list.map(getNodeTimestamp).filter((v) => Number.isFinite(v));
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 0;
  const timeBased = times.length >= 2 && max > min;
  const span = timeBased ? { min, max } : null;

  // In time mode, keep roughly the same overall density as index mode so the
  // ribbon doesn't suddenly become enormous or cramped: width target = N*spacing.
  const pixelsPerSecond = timeBased ? (list.length * dotSpacing) / (max - min) : null;

  // Preserve original order as a stable tiebreak / index-mode position.
  const indexed = list.map((node, idx) => ({ node, idx, ts: getNodeTimestamp(node) }));

  // Group into threads.
  const groups = new Map();
  for (const entry of indexed) {
    const key = threadKey(entry.node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const rows = [];
  for (const [key, entries] of groups) {
    // Sort a row's nodes by time (time mode) or original index.
    const sorted = [...entries].sort((a, b) => {
      if (timeBased && Number.isFinite(a.ts) && Number.isFinite(b.ts)) return a.ts - b.ts;
      return a.idx - b.idx;
    });

    let prev = null;
    let prevX = -Infinity;
    const placed = sorted.map((e) => {
      let x;
      if (timeBased && Number.isFinite(e.ts)) {
        x = railStart + (e.ts - min) * pixelsPerSecond;
        // Nudge so consecutive same-row dots never overlap. This only shifts
        // dots later (never earlier), so order is preserved; cross-row time
        // alignment stays accurate except where dots would collide.
        if (x < prevX + minDotSpacing) x = prevX + minDotSpacing;
      } else {
        // Index fallback keeps the legacy column spacing using global order.
        x = railStart + e.idx * dotSpacing;
      }

      const isReturn =
        timeBased &&
        prev != null &&
        Number.isFinite(e.ts) &&
        Number.isFinite(prev.ts) &&
        e.ts - prev.ts > returnGapSeconds;

      prev = e;
      prevX = x;
      return { ...e.node, x, isReturn, ts: e.ts };
    });

    rows.push({ threadId: key, label: threadLabel(key), count: placed.length, nodes: placed });
  }

  // Most-active thread on top (ADR-032 §A); ungrouped sinks to the bottom.
  // Stable tiebreak by the earliest node index so order is deterministic.
  rows.sort((a, b) => {
    const aUng = a.threadId === UNGROUPED_KEY;
    const bUng = b.threadId === UNGROUPED_KEY;
    if (aUng !== bUng) return aUng ? 1 : -1;
    if (b.count !== a.count) return b.count - a.count;
    const aFirst = a.nodes[0]?.x ?? 0;
    const bFirst = b.nodes[0]?.x ?? 0;
    return aFirst - bFirst;
  });

  let totalWidth = 0;
  for (const row of rows) {
    for (const n of row.nodes) {
      if (n.x > totalWidth) totalWidth = n.x;
    }
  }
  totalWidth += railStart;

  return { rows, totalWidth, timeBased, span, pixelsPerSecond };
}

/** Format seconds as m:ss or h:mm:ss (shared with the component). */
export function formatSecondsToTimestamp(rawSeconds) {
  const total = Math.max(0, Math.floor(Number(rawSeconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
