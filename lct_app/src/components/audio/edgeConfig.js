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

// Only accept a runtime url override that is HTTPS, credential-free, and on the
// tailnet (*.ts.net). A free-form ?edge_url= would otherwise let a crafted link
// send mic audio to an attacker endpoint (the M5 sends permissive CORS). Parse
// with URL() rather than a regex — robust against host-confusion (userinfo @,
// trailing-dot, evil.ts.net.attacker.com, etc.).
function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.hostname.toLowerCase().endsWith(".ts.net")
    );
  } catch {
    return false;
  }
}

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

  // url: a validated query override (persisted), else a validated stored value,
  // else the trusted default. Anything not HTTPS-on-tailnet is ignored.
  let url = DEFAULT_URL;
  try {
    const q = params.get("edge_url");
    if (q && isAllowedUrl(q)) {
      url = q;
      try {
        ls?.setItem(`${LS}_url`, q);
      } catch {
        /* session-only if storage is unavailable */
      }
    } else {
      const stored = ls?.getItem(`${LS}_url`);
      if (stored && isAllowedUrl(stored)) url = stored;
    }
  } catch {
    /* keep default */
  }

  // Optional bearer for when the M5 endpoint is locked down (today it's
  // unauthenticated on the trusted tailnet). Session-scoped via ?edge_token —
  // intentionally NOT persisted to storage (avoid leaving a bearer in localStorage).
  const token = params.get("edge_token") || "";

  return {
    enabled: flag("edge", LS),
    diarize: flag("edge_diarize", `${LS}_diarize`),
    includeEmbeddings: flag("edge_embeddings", `${LS}_embeddings`),
    url,
    token,
  };
}
