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
        <div className="bg-white/95 backdrop-blur rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-3 min-w-[140px] animate-slideIn">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-1.5 right-2 text-gray-400 hover:text-gray-600 text-xs"
          >
            close
          </button>

          {speakers.length > 0 && (
            <div>
              <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
                Speakers
              </span>
              <div className="mt-1 space-y-1">
                {speakers.map(([name, color]) => (
                  <div key={name} className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full border border-gray-300"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-gray-600">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
              Edges
            </span>
            <div className="mt-1 space-y-1">
              {EDGE_LEGEND.map(({ label, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                  <span className="text-gray-600">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="p-2 bg-white/70 hover:bg-white/90 backdrop-blur rounded-full shadow-sm border border-gray-200 text-gray-400 hover:text-gray-600 transition opacity-50 hover:opacity-100"
          title="Legend"
          aria-label="Show legend"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
