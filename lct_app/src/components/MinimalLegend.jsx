import { useState } from "react";
import PropTypes from "prop-types";

import { EDGE_COLORS } from "./graphConstants";

const EDGE_LEGEND = [
  { label: "supports", color: EDGE_COLORS.supports },
  { label: "rebuts", color: EDGE_COLORS.rebuts },
  { label: "clarifies", color: EDGE_COLORS.clarifies },
  { label: "tangent", color: EDGE_COLORS.tangent },
  { label: "returns", color: EDGE_COLORS.return_to_thread },
];

export default function MinimalLegend({ speakerColorMap }) {
  const [open, setOpen] = useState(false);
  const speakers = Object.entries(speakerColorMap || {});

  return (
    <div className="absolute bottom-14 right-4 z-20">
      {open ? (
        <div className="min-w-[140px] space-y-3 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs shadow-md backdrop-blur">
          <button
            onClick={() => setOpen(false)}
            className="absolute right-1 top-1 p-2 text-xs text-gray-400 transition hover:text-gray-600"
            aria-label="Close legend"
          >
            close
          </button>

          {speakers.length > 0 && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                Speakers
              </span>
              <div className="mt-1 space-y-1">
                {speakers.map(([name, color]) => (
                  <div key={name} className="flex items-center gap-2">
                    <div
                      className="h-3 w-3 rounded-full border border-gray-300"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-gray-600">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
              Edges
            </span>
            <div className="mt-1 space-y-1">
              {EDGE_LEGEND.map(({ label, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className="h-0.5 w-4" style={{ backgroundColor: color }} />
                  <span className="text-gray-600">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="rounded-full border border-gray-200 bg-white/70 p-3 text-gray-400 opacity-50 shadow-sm backdrop-blur transition hover:bg-white/90 hover:text-gray-600 hover:opacity-100"
          title="Legend"
          aria-label="Show legend"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        </button>
      )}
    </div>
  );
}

MinimalLegend.propTypes = {
  speakerColorMap: PropTypes.object,
};
