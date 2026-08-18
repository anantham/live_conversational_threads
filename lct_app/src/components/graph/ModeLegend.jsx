/**
 * ModeLegend — compact node-color legend for the ACTIVE color mode, rendered
 * beside ColorModeToggle so cycling modes always shows what the colors mean:
 *   thread   → one swatch per debate/thread in the graph
 *   rhetoric → the argument-map roles (claim / evidence / question / assumption)
 *   argument → incoming-edge statuses (disputed / supported / rebutted / …)
 *   tier     → the semantic tiers present
 *   speaker  → per-speaker swatches (capped)
 *   temporal/date → gradient note
 * Always appends the crux marker (amber ring) since it renders in every mode.
 */

import { useMemo } from "react";
import PropTypes from "prop-types";

import {
  ARGUMENT_STATUSES,
  ARGUMENT_ROLE_COLORS,
  TIER_LEGEND_COLORS,
} from "./colorModes";

const ARGUMENT_ROLE_ORDER = ["claim", "evidence", "question", "assumption", "context"];

export default function ModeLegend({ mode, nodes, speakerColorMap, threadColorMap }) {
  const entries = useMemo(() => {
    const list = nodes || [];

    if (mode === "thread") {
      const seen = new Map();
      list.forEach((n) => {
        const t = n.thread_id;
        if (t && !seen.has(t)) seen.set(t, threadColorMap?.[n.id]);
      });
      return [...seen.entries()].map(([t, fill]) => ({
        label: String(t).replace(/^thread-/, ""),
        fill: fill || "#f1f5f9",
      }));
    }

    if (mode === "rhetoric") {
      const present = new Set(list.map((n) => n.argument_role).filter(Boolean));
      const keys = ARGUMENT_ROLE_ORDER.filter((k) => present.has(k));
      // Graph without argument-role data: show the core vocabulary so the mode
      // is still self-describing rather than an empty row.
      const shown = keys.length > 0 ? keys : ARGUMENT_ROLE_ORDER;
      return shown.map((k) => ({ label: k, ...ARGUMENT_ROLE_COLORS[k] }));
    }

    if (mode === "argument") {
      return ARGUMENT_STATUSES.map((s) => ({
        label: s.label.toLowerCase(),
        fill: s.fill,
        border: s.border,
      }));
    }

    if (mode === "tier") {
      const present = new Set(list.map((n) => n.semantic_type).filter(Boolean));
      const pairs = Object.entries(TIER_LEGEND_COLORS).filter(([k]) => present.has(k));
      return (pairs.length > 0 ? pairs : Object.entries(TIER_LEGEND_COLORS)).map(
        ([k, c]) => ({ label: k, ...c })
      );
    }

    if (mode === "speaker") {
      return Object.entries(speakerColorMap || {})
        .slice(0, 8)
        .map(([s, fill]) => ({ label: s, fill }));
    }

    return null; // temporal / date → gradient note
  }, [mode, nodes, speakerColorMap, threadColorMap]);

  return (
    <div className="flex max-w-[440px] flex-wrap items-center gap-x-2 gap-y-1 pl-1">
      {entries === null ? (
        <span className="text-[10px] text-gray-400">gradient: red = earliest → violet = latest</span>
      ) : entries.length === 0 ? (
        <span className="text-[10px] text-gray-400">nothing to color in this graph</span>
      ) : (
        entries.map((e) => (
          <span key={e.label} className="inline-flex items-center gap-1 text-[10px] text-gray-600">
            <span
              style={{
                background: e.fill,
                border: `1px solid ${e.border || "#cbd5e1"}`,
                width: 10,
                height: 10,
                borderRadius: 3,
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            {e.label}
          </span>
        ))
      )}
      <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            display: "inline-block",
            background: "#fff",
            boxShadow: "0 0 0 2px #f59e0b",
            flexShrink: 0,
          }}
        />
        crux
      </span>
    </div>
  );
}

ModeLegend.propTypes = {
  mode: PropTypes.string.isRequired,
  nodes: PropTypes.array,
  speakerColorMap: PropTypes.object,
  threadColorMap: PropTypes.object,
};
