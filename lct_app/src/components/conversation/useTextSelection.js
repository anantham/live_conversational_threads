/**
 * useTextSelection — track the live text selection within a containerRef.
 *
 * Listens for selectionchange (and a debounced mouseup as fallback for
 * browsers where selectionchange doesn't always fire inside React-managed
 * subtrees). Returns the current selection if it falls inside the
 * container ref, otherwise null.
 *
 * Returns:
 *   {
 *     selection: { text, rect } | null,
 *     clearSelection: () => void  // collapses the selection
 *   }
 *
 * `rect` is a DOMRect-like {top, left, right, bottom, width, height} of the
 * union of selected text rectangles — use it to anchor the floating toolbar.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export default function useTextSelection(containerRef) {
  const [selection, setSelection] = useState(null);
  const containerNodeRef = useRef(null);

  // Keep a stable ref to the current container DOM node so the event
  // handler doesn't capture a stale React ref value.
  useEffect(() => {
    containerNodeRef.current = containerRef?.current ?? null;
  });

  useEffect(() => {
    let timer = null;

    const computeSelection = () => {
      const container = containerNodeRef.current;
      if (!container) {
        setSelection(null);
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelection(null);
        return;
      }

      const range = sel.getRangeAt(0);
      // Both endpoints must fall inside our container
      if (
        !container.contains(range.startContainer) ||
        !container.contains(range.endContainer)
      ) {
        setSelection(null);
        return;
      }

      const text = String(sel.toString() || "").trim();
      if (!text) {
        setSelection(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setSelection(null);
        return;
      }

      setSelection({
        text,
        rect: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      });
    };

    const onSelectionChange = () => {
      // Debounce to avoid thrashing during drag-select
      if (timer) clearTimeout(timer);
      timer = setTimeout(computeSelection, 30);
    };

    const onPointerUp = () => {
      // Some React subtrees don't always fire selectionchange reliably;
      // fall back to pointerup as a second trigger.
      if (timer) clearTimeout(timer);
      timer = setTimeout(computeSelection, 30);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const clearSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    setSelection(null);
  }, []);

  return { selection, clearSelection };
}
