import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TAILNET_STT_URL, isAllowedTailnetUrl, normalizeTailnetUrl, tailnetSuffixOf } from './tailnetEndpoint.js';
import { readEdgeConfig } from '../components/audio/edgeConfig.js';
import { normalizeProviderPreferences } from './cloud/sitesProviderPreferences.js';
import { M5TailnetFileSession } from './cloud/m5TailnetFileSession.js';

const OWN = 'https://other-host.tail4741ad.ts.net:5443/v1/audio/transcriptions';
const FUNNEL = 'https://attacker-box.tailEVIL.ts.net/v1/audio/transcriptions';

function memStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

describe('tailnet endpoint allowlist', () => {
  it('reads the tailnet from a machine name and nothing else', () => {
    expect(tailnetSuffixOf(DEFAULT_TAILNET_STT_URL)).toBe('.tail4741ad.ts.net');
    expect(tailnetSuffixOf('https://tail4741ad.ts.net/v1')).toBeNull(); // no machine label
    expect(tailnetSuffixOf('https://a.b.tail4741ad.ts.net/v1')).toBeNull(); // extra label
    expect(tailnetSuffixOf('https://a.tail4741ad.ts.net.evil.com/v1')).toBeNull();
    expect(tailnetSuffixOf('not a url')).toBeNull();
  });

  it("accepts the build's own tailnet only, never another tailnet's public Funnel name", () => {
    expect(isAllowedTailnetUrl(DEFAULT_TAILNET_STT_URL)).toBe(true);
    expect(isAllowedTailnetUrl(OWN)).toBe(true);
    expect(isAllowedTailnetUrl(OWN.replace('other-host.tail4741ad', 'OTHER-HOST.TAIL4741AD'))).toBe(true);
    // another service on our own tailnet is not the transcription route
    expect(isAllowedTailnetUrl('https://other-host.tail4741ad.ts.net:8080/admin/upload')).toBe(false);
    expect(isAllowedTailnetUrl(FUNNEL)).toBe(false);
    expect(isAllowedTailnetUrl('https://x.ts.net@other-host.tail4741ad.ts.net.evil.com/v1')).toBe(false);
    expect(isAllowedTailnetUrl('http://other-host.tail4741ad.ts.net/v1')).toBe(false);
  });

  it('fails closed when the build default names no tailnet', async () => {
    vi.stubEnv('VITE_STT_EDGE_URL', 'https://stt.example.com/v1/audio/transcriptions');
    vi.resetModules();
    try {
      const fresh = await import('./tailnetEndpoint.js');
      expect(fresh.DEFAULT_TAILNET_STT_URL).toBe('https://stt.example.com/v1/audio/transcriptions');
      expect(fresh.isAllowedTailnetUrl(OWN)).toBe(false);
      expect(fresh.isAllowedTailnetUrl(fresh.DEFAULT_TAILNET_STT_URL)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('returns the canonical href, so what is stored and fetched is what was checked', () => {
    // JS trim() removes NBSP and U+FEFF but the URL parser keeps them; the raw value
    // would fetch as a relative URL on the app's origin.
    expect(normalizeTailnetUrl(`\u00A0${OWN}`)).toBe(OWN);
    expect(normalizeTailnetUrl(`\uFEFF${OWN}`)).toBe(OWN);
    expect(readEdgeConfig(`?edge_url=${encodeURIComponent(`\u00A0${OWN}`)}`, memStorage()).url).toBe(OWN);
  });

  it('drops a stored Funnel address from saved Sites settings and keeps an own-tailnet one', () => {
    expect(normalizeProviderPreferences({ m5TailnetUrl: FUNNEL }).m5TailnetUrl).toBe('');
    expect(normalizeProviderPreferences({ m5TailnetUrl: ` ${OWN} ` }).m5TailnetUrl).toBe(OWN);
  });

  it('never posts file audio to a Funnel address handed to the import session', async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { calls.push([String(url), init?.redirect]); throw new TypeError('offline'); };
    try {
      const session = new M5TailnetFileSession({ url: FUNNEL });
      await session.start({ file: new File([new Uint8Array(8)], 'a.wav', { type: 'audio/wav' }) }).catch(() => {});
    } finally {
      globalThis.fetch = original;
    }
    // Sent to the trusted default instead, and never allowed to follow a redirect off it.
    expect(calls).toEqual([[DEFAULT_TAILNET_STT_URL, 'error']]);
  });
});
