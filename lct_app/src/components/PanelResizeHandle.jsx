import { useRef } from "react";
import PropTypes from "prop-types";

export default function PanelResizeHandle({ label, vertical = false, value, min, max, onChange }) {
  const drag = useRef(null);
  const clamp = size => Math.max(min, Math.min(max, size));
  return <div role="separator" tabIndex={0} aria-label={label}
    aria-orientation={vertical ? "horizontal" : "vertical"}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { start: vertical ? event.clientY : event.clientX, value };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      const delta = (vertical ? event.clientY : event.clientX) - drag.current.start;
      onChange(clamp(drag.current.value + (vertical ? -delta : delta)));
    }}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const grow = vertical ? "ArrowUp" : "ArrowRight";
      const shrink = vertical ? "ArrowDown" : "ArrowLeft";
      if (![grow, shrink, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      onChange(event.key === "Home" ? min : event.key === "End" ? max : clamp(value + (event.key === grow ? 24 : -24)));
    }}
    className={`touch-none bg-slate-100 hover:bg-amber-200 focus-visible:bg-amber-200 ${vertical ? "h-2 w-full cursor-row-resize" : "absolute inset-y-0 right-0 w-2 cursor-col-resize"}`}
  />;
}
PanelResizeHandle.propTypes = { label: PropTypes.string.isRequired, vertical: PropTypes.bool, value: PropTypes.number.isRequired, min: PropTypes.number.isRequired, max: PropTypes.number.isRequired, onChange: PropTypes.func.isRequired };
