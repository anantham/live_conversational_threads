import { useEffect, useId, useRef } from "react";
import PropTypes from "prop-types";
import { X } from "lucide-react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function MobileDeckSheet({ children, onClose, open, title }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const previousFocus = document.activeElement;
    panel?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll(FOCUSABLE)]
        .filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel?.addEventListener("keydown", onKeyDown);
    return () => {
      panel?.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[90] ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      inert={open ? undefined : ""}
    >
      <button
        type="button"
        aria-label="Close options"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 h-full w-full bg-slate-950/25 transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-open={String(open)}
        className="t-panel-slide absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl outline-none"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold tracking-[-0.02em] text-slate-800">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

MobileDeckSheet.propTypes = {
  children: PropTypes.node,
  onClose: PropTypes.func.isRequired,
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
};
