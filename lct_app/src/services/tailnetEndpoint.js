// Test intent:
// - The browser sends audio only to machines on the tailnet named by the build's trusted
//   default endpoint, never to an arbitrary *.ts.net host. Tailscale Funnel publishes any
//   tailnet's machines as public *.ts.net names, so "ends with .ts.net" let a crafted
//   ?edge_url= or a stored setting route a visitor's audio to someone else's Funnel.
// - One predicate serves the ?edge_url= override, saved Sites settings and the file-import
//   session, so no entry point can be looser than another.
// - A build whose default is not a tailnet URL accepts no override (fails closed); the
//   build-time default itself stays usable because it is not user-controlled.

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

export function isAllowedTailnetUrl(value, trustedSuffix = TRUSTED_SUFFIX) {
  if (!trustedSuffix || typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      tailnetSuffixOf(parsed.href) === trustedSuffix
    );
  } catch {
    return false;
  }
}
