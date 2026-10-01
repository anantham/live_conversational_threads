import { afterEach, expect, it, vi } from 'vitest';
import { recordSourceLoadTiming } from './sourceLoadTiming';
// Intent: source waits retain bounded operational measurements and exclude source content.
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('bounds timing history and stores only operational fields', () => {
  for (let index = 0; index < 30; index += 1) recordSourceLoadTiming({ outcome: 'success', retries: 0, apiMs: 20, elapsedMs: 80, videoId: 'private', passage: 'private' });
  const saved = localStorage.getItem('threads.source-load-timing.v1');
  expect(JSON.parse(saved)).toHaveLength(24);
  expect(saved).not.toContain('private');
  expect(JSON.parse(saved)[0]).toMatchObject({ outcome: 'success', apiMs: 20, elapsedMs: 80, retries: 0 });
});
it('tolerates corrupt or unavailable storage and keeps unknown measurements null', () => {
  localStorage.setItem('threads.source-load-timing.v1', '[null]');
  recordSourceLoadTiming({ outcome: 'cancelled' });
  expect(JSON.parse(localStorage.getItem('threads.source-load-timing.v1'))[0]).toMatchObject({ apiMs: null, elapsedMs: null });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  expect(() => recordSourceLoadTiming({ outcome: 'error' })).not.toThrow();
});
