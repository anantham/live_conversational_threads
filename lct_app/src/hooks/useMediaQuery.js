import { useEffect, useState } from "react";

export const COMPACT_VIEWER_QUERY = "(max-width: 639px), (hover: none) and (pointer: coarse)";

export function mediaQueryMatches(query) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => mediaQueryMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}
