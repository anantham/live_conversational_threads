/**
 * One gated, namespaced diagnostic logger for the frontend.
 *
 * Replaces the four ad-hoc gates that existed before (TRACE_API,
 * window.__MG_DEBUG__, window.__LCT_DEBUG_AUDIO, VITE_GRAPH_DEBUG). Per
 * AGENTS.md #9: diagnostic logging is gated behind a variable and is OFF by
 * default in every environment — you opt IN to see it. This keeps private
 * conversation content out of the browser console unless a developer asks for it.
 *
 * Turn a namespace on (any one is enough; comma-separated list, or "*" for all):
 *   - build-time:        VITE_LCT_DEBUG="api,graph"   (or "*"/"1"/"true")
 *   - runtime, sticky:   localStorage["lct:debug"] = "graph"   (survives reload)
 *   - runtime, console:  window.__lctDebug.enable("graph")     (writes localStorage)
 *   - runtime, ephemeral: window.__LCT_DEBUG__ = "graph"       (lost on reload)
 *
 * Usage:
 *   import { makeDebug } from "../utils/debug";
 *   const debug = makeDebug("graph");
 *   debug("camera landed", tier);            // -> console.log("[graph] camera landed", tier) when on
 *   debug.warn("persist failed", err);
 *   if (debug.enabled) console.table(expensiveToBuild());
 *
 * NOTE on errors: genuine user-facing failures should stay as raw `console.error`
 * (AGENTS.md #9 — do not silence failures). `debug.error` is only for verbose,
 * default-silenced diagnostic errors.
 */

// Vite env is fixed at build time; read once. Wrapped so non-Vite contexts
// (e.g. Vitest without the define) don't throw.
const ENV_RAW = (() => {
  try {
    return String(import.meta.env?.VITE_LCT_DEBUG ?? "").trim();
  } catch {
    return "";
  }
})();

const WILDCARD = new Set(["*", "1", "true", "yes", "on", "all"]);

function readRuntimeSources() {
  if (typeof window === "undefined") return "";
  let ls = "";
  try {
    ls = window.localStorage?.getItem("lct:debug") ?? "";
  } catch {
    // private mode / blocked storage — fall through to the window global
  }
  const win = window.__LCT_DEBUG__;
  const winStr = win === true ? "*" : typeof win === "string" ? win : "";
  return [ls, winStr].filter(Boolean).join(",");
}

// Recompute the active token set only when a source string actually changed, so
// a mid-session toggle takes effect with no reload while the steady state stays
// a single string compare.
let _lastCombined = null;
let _lastTokens = [];
function activeTokens() {
  const combined = [ENV_RAW, readRuntimeSources()].filter(Boolean).join(",");
  if (combined === _lastCombined) return _lastTokens;
  _lastCombined = combined;
  _lastTokens = combined
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return _lastTokens;
}

function namespaceEnabled(ns) {
  const tokens = activeTokens();
  if (tokens.length === 0) return false;
  const name = ns.toLowerCase();
  for (const t of tokens) {
    if (WILDCARD.has(t)) return true;
    if (t === name) return true;
    if (t.endsWith("*") && name.startsWith(t.slice(0, -1))) return true; // "graph*"
  }
  return false;
}

const _registry = new Map();

/**
 * Create (or reuse) a namespaced debug logger.
 * @param {string} namespace e.g. "api", "graph", "audio", "upload"
 * @returns a callable console.log-equivalent with .log/.info/.warn/.error and an `enabled` getter.
 */
export function makeDebug(namespace) {
  const ns = String(namespace || "app");
  if (_registry.has(ns)) return _registry.get(ns);

  const prefix = `[${ns}]`;
  const emit = (method, args) => {
    if (!namespaceEnabled(ns)) return; // single boolean short-circuit when off
    console[method](prefix, ...args);
  };

  const debug = (...args) => emit("log", args);
  debug.log = debug;
  debug.info = (...args) => emit("info", args);
  debug.warn = (...args) => emit("warn", args);
  debug.error = (...args) => emit("error", args);
  Object.defineProperty(debug, "enabled", { get: () => namespaceEnabled(ns) });

  _registry.set(ns, debug);
  return debug;
}

// Triage prod issues without a rebuild:  __lctDebug.enable("graph,api")  then retry.
if (typeof window !== "undefined") {
  window.__lctDebug = {
    enable(value = "*") {
      try {
        window.localStorage?.setItem("lct:debug", String(value));
      } catch {
        /* storage blocked */
      }
      window.__LCT_DEBUG__ = String(value);
    },
    disable() {
      try {
        window.localStorage?.removeItem("lct:debug");
      } catch {
        /* storage blocked */
      }
      window.__LCT_DEBUG__ = undefined;
    },
    list: () => activeTokens(),
  };
}
