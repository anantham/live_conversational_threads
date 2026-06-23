/**
 * Runtime config for edge STT (ADR-056 Phase 1c + #7 kill switch).
 *
 * A RUNTIME toggle (not a build-time `VITE_*` flag) so it can be flipped on a
 * deployed build with no rebuild, and turned off instantly as a kill switch:
 *   - `?edge=1` / `?edge=0` enables/disables and PERSISTS to localStorage
 *     (so it sticks across reloads); absent → the stored value (default OFF).
 *   - `?edge_diarize=1`, `?edge_embeddings=1` toggle the M5 request flags.
 *   - `?edge_url=...` overrides the M5 endpoint.
 *
 * Pure-ish: pass `search` + a `storage` shim for tests.
 */

const LS = "lct_stt_edge";
const DEFAULT_URL =
  import.meta.env.VITE_STT_EDGE_URL ||
  "https://adityas-macbook-pro.tail4741ad.ts.net:5443/v1/audio/transcriptions";

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readEdgeConfig(search = "", storage = undefined) {
  const params = new URLSearchParams(search || "");
  const ls = resolveStorage(storage);

  // ?<qp>=1|0 sets+persists; otherwise read the stored flag (default off).
  const flag = (qp, key) => {
    const q = params.get(qp);
    if (q === "1" || q === "0") {
      try {
        ls?.setItem(key, q);
      } catch {
        /* storage may be unavailable; fall through to the query value */
      }
      return q === "1";
    }
    try {
      return (ls?.getItem(key) ?? "0") === "1";
    } catch {
      return false;
    }
  };

  let url = DEFAULT_URL;
  try {
    url = params.get("edge_url") || ls?.getItem(`${LS}_url`) || DEFAULT_URL;
  } catch {
    /* keep default */
  }

  return {
    enabled: flag("edge", LS),
    diarize: flag("edge_diarize", `${LS}_diarize`),
    includeEmbeddings: flag("edge_embeddings", `${LS}_embeddings`),
    url,
  };
}
