import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";

/** Native button or link semantics with hoverable, dismissible keyboard help. */
export default function TooltipButton({ as: Control = "button", tooltip, compact = false, placement = "bottom", align = "start", disabled = false, children, onClick, style, ...controlProps }) {
  const id = useId();
  const trigger = useRef(null);
  const bubble = useRef(null);
  const leaveTimer = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const cancelLeave = () => clearTimeout(leaveTimer.current);
  const hide = () => { cancelLeave(); setOpen(false); };
  const show = () => { cancelLeave(); setOpen(true); };
  const leave = (event) => {
    const destination = event.relatedTarget;
    if (destination instanceof Node && (trigger.current?.contains(destination) || bubble.current?.contains(destination))) return;
    if (trigger.current?.contains(document.activeElement)) return;
    cancelLeave();
    leaveTimer.current = setTimeout(() => setOpen(false), 100);
  };

  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!trigger.current || !bubble.current) return;
      const target = trigger.current.getBoundingClientRect();
      const hint = bubble.current.getBoundingClientRect();
      const offsets = { start: 0, center: (target.width - hint.width) / 2, end: target.width - hint.width };
      const left = Math.max(8, Math.min(target.left + offsets[align], window.innerWidth - hint.width - 8));
      const above = target.top - hint.height - 6;
      const below = target.bottom + 6;
      const preferred = placement === "top" ? above : below;
      const alternate = placement === "top" ? below : above;
      const fits = (top) => top >= 8 && top + hint.height <= window.innerHeight - 8;
      const top = fits(preferred) ? preferred : fits(alternate) ? alternate : Math.max(8, Math.min(preferred, window.innerHeight - hint.height - 8));
      setPosition(previous => previous?.left === left && previous?.top === top ? previous : { left, top });
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      if (trigger.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
      setOpen(false);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, placement, align, tooltip]);

  const description = [controlProps["aria-describedby"], tooltip === controlProps["aria-label"] ? null : id].filter(Boolean).join(" ");
  const nativeButtonProps = Control === "button" ? { type: controlProps.type || "button", disabled } : {};
  return <>
    <span ref={trigger} className="inline-flex shrink-0" role={disabled ? "group" : undefined}
      tabIndex={disabled ? 0 : undefined} aria-label={disabled ? `${controlProps["aria-label"] || "Navigation"} (unavailable)` : undefined}
      aria-disabled={disabled || undefined} aria-describedby={disabled ? description || undefined : undefined}
      onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={hide}>
      <Control {...controlProps} {...nativeButtonProps} aria-describedby={description || undefined}
        style={{ ...style, ...(disabled ? { pointerEvents: "none" } : {}) }}
        onClick={(event) => { hide(); onClick?.(event); }}>{children}</Control>
    </span>
    {open && createPortal(<span ref={bubble} id={id} role="tooltip"
      className={compact
        ? "fixed z-[100] w-max max-w-[calc(100vw-1rem)] rounded-lg bg-slate-900 px-3 py-2 text-sm leading-snug text-white shadow-md"
        : "fixed z-[100] w-[min(18rem,calc(100vw-1rem))] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-700 shadow-md"}
      style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}
      onMouseEnter={show} onMouseLeave={leave}>{tooltip}</span>, document.body)}
  </>;
}

TooltipButton.propTypes = {
  as: PropTypes.elementType,
  tooltip: PropTypes.string.isRequired,
  compact: PropTypes.bool,
  placement: PropTypes.oneOf(["top", "bottom"]),
  align: PropTypes.oneOf(["start", "center", "end"]),
  disabled: PropTypes.bool,
  children: PropTypes.node,
  onClick: PropTypes.func,
  style: PropTypes.object,
};
