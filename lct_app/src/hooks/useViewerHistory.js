import { useCallback, useEffect, useRef, useState } from "react";

const markerKey = "lctExploration";
const copy = (value) => JSON.parse(JSON.stringify(value));
const signature = (state) => JSON.stringify({ ...state, graphNavigation: undefined, mediaNode: undefined,
  discussionFocus: state.discussionFocus?.id || null });
const readScroll = (root) => Object.fromEntries(
  [...(root?.querySelectorAll("[data-viewer-scroll]") || [])].map((element) => [
    element.dataset.viewerScroll, { top: element.scrollTop, left: element.scrollLeft },
  ]),
);

/** Session-local exploration. Browser entries contain opaque pointers, never source data. */
export function useViewerHistory({ enabled, sessionKey, state, onRestore, rootRef }) {
  const session = useRef(null);
  const latest = useRef({ state, onRestore });
  latest.current = { state, onRestore };
  const replaying = useRef(false);
  const [position, setPosition] = useState({ cursor: 0, count: 1 });
  const [restoreKey, setRestoreKey] = useState(0);

  useEffect(() => {
    if (!enabled) { session.current = null; return undefined; }
    const owner = window.crypto.randomUUID();
    const initial = { state: copy(latest.current.state), scroll: readScroll(rootRef.current), url: window.location.href };
    session.current = { owner, cursor: 0, entries: [initial] };
    replaying.current = false;
    setPosition({ cursor: 0, count: 1 });
    window.history.replaceState({ ...window.history.state, [markerKey]: { owner, cursor: 0 } }, "");
    let frame;
    let settleFrame;
    const restore = (event) => {
      const current = session.current;
      const marker = event.state?.[markerKey];
      if (!current || marker?.owner !== current.owner || !Number.isInteger(marker.cursor)) return;
      const entry = current.entries[marker.cursor];
      if (!entry || entry.url !== window.location.href) return;
      current.cursor = marker.cursor;
      replaying.current = true;
      latest.current.onRestore(copy(entry.state));
      setRestoreKey((key) => key + 1);
      setPosition({ cursor: current.cursor, count: current.entries.length });
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
      frame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(() => {
          rootRef.current?.querySelectorAll("[data-viewer-scroll]").forEach((element) => {
            const saved = entry.scroll[element.dataset.viewerScroll];
            if (saved) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
          });
          replaying.current = false;
        });
      });
    };
    window.addEventListener("popstate", restore);
    const onKey = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const current = session.current;
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!current || !direction || current.cursor + direction < 0 || current.cursor + direction >= current.entries.length) return;
      event.preventDefault(); window.history.go(direction);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
    };
  }, [enabled, sessionKey, rootRef]);

  useEffect(() => {
    if (!enabled || !session.current || replaying.current) return undefined;
    // Coalesce one React interaction and child reports into one navigation entry.
    const timer = setTimeout(() => {
      const current = session.current;
      if (!current || replaying.current) return;
      const previous = current.entries[current.cursor];
      const snapshot = {
        state: copy(latest.current.state),
        scroll: { ...previous.scroll, ...readScroll(rootRef.current) },
        url: window.location.href,
      };
      if (signature(previous.state) === signature(snapshot.state)) {
        current.entries[current.cursor] = snapshot;
        return;
      }
      current.entries.splice(current.cursor + 1);
      current.entries.push(snapshot);
      current.cursor += 1;
      const routerState = window.history.state;
      window.history.pushState({
        ...routerState,
        ...(Number.isInteger(routerState?.idx) ? { idx: routerState.idx + 1 } : {}),
        [markerKey]: { owner: current.owner, cursor: current.cursor },
      }, "");
      setPosition({ cursor: current.cursor, count: current.entries.length });
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled, sessionKey, state, rootRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    const root = rootRef.current;
    const rememberScroll = () => {
      const current = session.current;
      if (!current || replaying.current) return;
      const entry = current.entries[current.cursor];
      entry.scroll = { ...entry.scroll, ...readScroll(root) };
    };
    root?.addEventListener("scroll", rememberScroll, true);
    return () => root?.removeEventListener("scroll", rememberScroll, true);
  }, [enabled, rootRef, state.viewMode]);

  const goBack = useCallback(() => {
    if (session.current?.cursor > 0) window.history.back();
  }, []);
  const goForward = useCallback(() => {
    const current = session.current;
    if (current && current.cursor < current.entries.length - 1) window.history.forward();
  }, []);
  return { canBack: position.cursor > 0, canForward: position.cursor < position.count - 1, goBack, goForward, restoreKey };
}
