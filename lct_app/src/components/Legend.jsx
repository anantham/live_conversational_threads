import { useState, useMemo } from "react";

const POSITION_CLASSES = {
  "bottom-left": "bottom-4 left-4",
  "bottom-right": "bottom-4 right-4",
  "top-left": "top-4 left-4",
  "top-right": "top-4 right-4",
};

export default function Legend({ position = "bottom-left" }) {
  const [isOpen, setIsOpen] = useState(false);
  const posClass = useMemo(() => POSITION_CLASSES[position] || POSITION_CLASSES["bottom-left"], [position]);

  const items = [
    { label: "Selected node", color: "#F97316", note: "Active selection" },
    { label: "Utterance-highlighted node", color: "#22C55E", note: "Matches selected utterance(s)" },
    { label: "Edge: supports/informs", color: "#22C55E", note: "supporting / informative" },
    { label: "Edge: contradicts/opposes", color: "#EF4444", note: "conflict / opposition" },
    { label: "Edge: neutral/structural", color: "#94A3B8", note: "other relations" },
  ];

  return (
    <div
      className={`fixed z-30 ${posClass} group`}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      {!isOpen && (
        <button
          className="px-3 py-2 rounded-full bg-white/90 text-xs font-semibold text-gray-700 shadow hover:bg-white"
          onClick={() => setIsOpen(true)}
        >
          Legend
        </button>
      )}

      {isOpen && (
        <div className="min-w-[200px] shadow-lg rounded-lg p-3 text-xs text-gray-800 border border-gray-300 bg-white/95 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm">Legend</h4>
            <button
              className="text-gray-500 hover:text-gray-700 text-xs"
              onClick={() => setIsOpen(false)}
              aria-label="Close legend"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <div key={item.label} className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded-sm border"
                  style={{ backgroundColor: `${item.color}55`, borderColor: item.color }}
                  aria-hidden="true"
                />
                <div className="leading-tight">
                  <div className="font-semibold">{item.label}</div>
                  <div className="text-[11px] text-gray-600">{item.note}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-gray-500">
            Tip: Use the toolbar box icon to refit the view.
          </div>
        </div>
      )}
    </div>
  );
}
