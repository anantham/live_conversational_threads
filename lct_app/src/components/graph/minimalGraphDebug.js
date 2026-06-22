/** Diagnostic logging for MinimalGraph camera/viewport investigations. */

export function mglog(...args) {
  if (typeof window !== "undefined" && window.__MG_DEBUG__) {
    console.log("[MG]", ...args);
  }
}