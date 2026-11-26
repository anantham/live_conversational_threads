import { describe, expect, it } from 'vitest';

import { DEFAULT_TAILNET_STT_URL, isAllowedTailnetUrl, tailnetSuffixOf } from './tailnetEndpoint.js';
import { normalizeProviderPreferences } from './cloud/sitesProviderPreferences.js';
import { M5TailnetFileSession } from './cloud/m5TailnetFileSession.js';

const OWN = 'https://other-host.tail4741ad.ts.net:5443/v1/audio/transcriptions';
const FUNNEL = 'https://attacker-box.tailEVIL.ts.net/v1/audio/transcriptions';

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
    expect(isAllowedTailnetUrl(OWN.toUpperCase().replace('HTTPS', 'https'))).toBe(true);
    expect(isAllowedTailnetUrl(FUNNEL)).toBe(false);
    expect(isAllowedTailnetUrl('https://x.ts.net@other-host.tail4741ad.ts.net.evil.com/v1')).toBe(false);
    expect(isAllowedTailnetUrl('http://other-host.tail4741ad.ts.net/v1')).toBe(false);
  });

  it('fails closed when the trusted default names no tailnet', () => {
    expect(isAllowedTailnetUrl(OWN, null)).toBe(false);
    expect(isAllowedTailnetUrl(OWN, tailnetSuffixOf('https://stt.example.com/v1'))).toBe(false);
  });

  it('drops a stored Funnel address from saved Sites settings and keeps an own-tailnet one', () => {
    expect(normalizeProviderPreferences({ m5TailnetUrl: FUNNEL }).m5TailnetUrl).toBe('');
    expect(normalizeProviderPreferences({ m5TailnetUrl: ` ${OWN} ` }).m5TailnetUrl).toBe(OWN);
  });

  it('never posts file audio to a Funnel address handed to the import session', async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('offline'); };
    try {
      const session = new M5TailnetFileSession({ url: FUNNEL });
      await session.start({ file: new File([new Uint8Array(8)], 'a.wav', { type: 'audio/wav' }) }).catch(() => {});
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([DEFAULT_TAILNET_STT_URL]);
  });
});
