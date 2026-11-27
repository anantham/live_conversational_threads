// Test intent: see liveMapHeartbeatModel.js. Synthetic text only.
import { describe, expect, it } from 'vitest';
import { liveMapHeartbeat, MIN_NEW_MAP_CHARS } from './liveMapHeartbeatModel.js';

const mapped = 'Hello there. ';
const schedule = (overrides = {}) => ({ state: 'scheduled', canMapNow: true, complete: false, lastAttemptAt: 100_000,
  mappedChars: mapped.length, intervalMs: 25_000, minNewChars: MIN_NEW_MAP_CHARS, attemptsUsed: 1, maxAttempts: 20, ...overrides });
const longTail = 'We follow one more thread about a synthetic community garden and the reading group that meets beside it every week in spring.';

describe('live map heartbeat', () => {
  it('shows nothing before the map panel has reported a schedule', () => {
    expect(liveMapHeartbeat(null, 'Hello there.')).toBeNull();
  });

  it('counts down to the next update and counts only the words the next map adds', () => {
    const beat = liveMapHeartbeat(schedule(), mapped + longTail, 111_000);
    expect(longTail.length).toBeGreaterThanOrEqual(MIN_NEW_MAP_CHARS);
    expect(beat).toEqual({ label: 'Next map in 14 s · 22 new words', busy: false, action: 'map' });
  });

  it('says it is listening, without a countdown, until enough new words have arrived', () => {
    const beat = liveMapHeartbeat(schedule(), `${mapped}Two more.`, 111_000);
    expect(beat.label).toBe('Listening · 2 new words');
    expect(beat.action).toBe('map');
  });

  it('never shows a negative countdown once the interval has passed', () => {
    expect(liveMapHeartbeat(schedule(), mapped + longTail, 200_000).label).toBe('Mapping next · 22 new words');
  });

  it('reports work in flight and offers no second request while mapping', () => {
    expect(liveMapHeartbeat(schedule({ state: 'mapping', canMapNow: false }), mapped + longTail, 111_000))
      .toEqual({ label: 'Mapping…', busy: true, action: null });
  });

  it('does not offer to re-send words the map already covers', () => {
    const beat = liveMapHeartbeat(schedule({ state: 'manual' }), mapped, 111_000);
    expect(beat).toEqual({ label: 'Map is up to date', busy: false, action: null });
  });

  it('offers a first map when updates are manual and nothing has been mapped yet', () => {
    const beat = liveMapHeartbeat(schedule({ state: 'manual', mappedChars: 0, attemptsUsed: 0, lastAttemptAt: 0 }), 'Hello there. Again.', 111_000);
    expect(beat).toEqual({ label: '3 new words', busy: false, action: 'map' });
  });

  it('after Stop, maps any remaining words once and then reports the map as current', () => {
    expect(liveMapHeartbeat(schedule({ complete: true }), `${mapped}Bye.`, 111_000).label).toBe('Next map in 14 s · 1 new word');
    expect(liveMapHeartbeat(schedule({ complete: true }), mapped, 111_000)).toEqual({ label: 'Map is up to date', busy: false, action: null });
  });

  it('keeps a deliberate update available after automatic updates run out', () => {
    const beat = liveMapHeartbeat(schedule({ state: 'limit', attemptsUsed: 20 }), mapped + longTail, 111_000);
    expect(beat).toEqual({ label: 'Automatic updates used · 22 new words', busy: false, action: 'map' });
  });

  it('routes the reader to the panel when the map cannot run from the canvas', () => {
    expect(liveMapHeartbeat(schedule({ state: 'needs-consent', canMapNow: false }), mapped, 1))
      .toEqual({ label: 'Live map is off', busy: false, action: 'open', actionLabel: 'Set up' });
    expect(liveMapHeartbeat(schedule({ state: 'unavailable', canMapNow: false }), mapped, 1))
      .toEqual({ label: 'Map making is unavailable', busy: false, action: 'open', actionLabel: 'See why' });
  });

  it('offers a retry after a failed attempt even though that attempt recorded its words as sent', () => {
    expect(liveMapHeartbeat(schedule({ state: 'error' }), mapped, 1))
      .toEqual({ label: 'Last map did not finish', busy: false, action: 'map', actionLabel: 'Try again' });
    expect(liveMapHeartbeat(schedule({ state: 'error', canMapNow: false }), mapped, 1).action).toBe('open');
  });

  it('builds its label from counts alone, never from transcript text', () => {
    const secret = 'Zyxwvut confidential codename';
    for (const state of ['scheduled', 'manual', 'limit', 'error', 'mapping', 'needs-consent', 'unavailable']) {
      const beat = liveMapHeartbeat(schedule({ state }), `${mapped}${secret} ${longTail}`, 111_000);
      expect(`${beat.label} ${beat.actionLabel || ''}`).not.toMatch(/Zyxwvut|codename|garden/);
    }
  });

  it('tolerates a transcript shorter than the mapped length without a negative count', () => {
    expect(liveMapHeartbeat(schedule({ state: 'manual', mappedChars: 500 }), 'Short.', 1).label).toBe('Map is up to date');
  });
});
