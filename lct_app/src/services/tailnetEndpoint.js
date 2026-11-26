// Test intent:
// - The browser sends audio only to machines on the tailnet named by the build's trusted
//   default endpoint, never to an arbitrary *.ts.net host. Tailscale Funnel publishes any
//   tailnet's machines as public *.ts.net names, so "ends with .ts.net" let a crafted
//   ?edge_url= or a stored setting route a visitor's audio to someone else's Funnel.
// - One predicate serves the ?edge_url= override, saved Sites settings and the file-import
//   session, so no entry point can be looser than another.
// - A build whose default is not a tailnet URL accepts no override (fails closed); the
//   build-time default itself stays usable because it is not user-controlled.
// - Only the default's path (the OpenAI-compatible transcription route) is accepted, so a
//   link cannot aim audio at some other service on the tailnet.
// - Callers store and fetch the normalized href, never the raw input: JS trim() strips
//   characters (NBSP, U+FEFF) the URL parser keeps, so "validate trimmed, fetch raw" would
//   let a crafted value become a relative URL on the app's own origin.

const OWNER_STT_URL = 'https://adityas-macbook-pro.tail4741ad.ts.net:5443/v1/audio/transcriptions';

export const DEFAULT_TAILNET_STT_URL = import.meta.env?.VITE_STT_EDGE_URL || OWNER_STT_URL;

// "<machine>.<tailnet>.ts.net" → ".<tailnet>.ts.net"; anything else → null.
export function tailnetSuffixOf(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const labels = host.split('.');
    if (labels.length !== 4 || labels[2] !== 'ts' || labels[3] !== 'net' || labels.some((label) => !label)) return null;
    return `.${labels.slice(1).join('.')}`;
  } catch {
    return null;
  }
}

const TRUSTED_SUFFIX = tailnetSuffixOf(DEFAULT_TAILNET_STT_URL);
const TRUSTED_PATH = (() => {
  try { return new URL(DEFAULT_TAILNET_STT_URL).pathname; } catch { return null; }
})();

// Returns the canonical href of an acceptable endpoint, or null.
export function normalizeTailnetUrl(value, trustedSuffix = TRUSTED_SUFFIX, trustedPath = TRUSTED_PATH) {
  if (!trustedSuffix || !trustedPath || typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const ok = parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      tailnetSuffixOf(parsed.href) === trustedSuffix &&
      parsed.pathname === trustedPath;
    return ok ? parsed.href : null;
  } catch {
    return null;
  }
}

export function isAllowedTailnetUrl(value, trustedSuffix = TRUSTED_SUFFIX, trustedPath = TRUSTED_PATH) {
  return normalizeTailnetUrl(value, trustedSuffix, trustedPath) !== null;
}
