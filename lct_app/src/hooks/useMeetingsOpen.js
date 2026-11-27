import { useEffect, useState } from 'react';

// Test intent (critique 2026-11-25 issue 3; owner ruling 2026-11-26 "closed for now"):
// - Home learns whether Meet is open from the public health check, which creates no session.
// - Only a well-formed "not available" answer marks Meet closed. A failed or unreadable check
//   leaves the door as it is, because "we could not tell" is not evidence that it is closed.
// - Outside Sites mode there is no such check, so nothing is fetched.
// - A new revision asks again (the Meet page's Check connection); a failed re-check keeps the
//   last well-formed answer.

export function readMeetingsOpen(value) {
  if (!value || value.service !== 'meetings' || typeof value.available !== 'boolean') return 'unknown';
  return value.available ? 'open' : 'closed';
}

export function useMeetingsOpen(enabled = import.meta.env.VITE_SITES_MODE === 'true', revision = 0) {
  const [state, setState] = useState('unknown');
  useEffect(() => {
    if (!enabled || typeof fetch !== 'function') return undefined;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    fetch('/api/cloud/health/meetings', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(response => (response.ok ? response.json() : null))
      .then(value => { const next = readMeetingsOpen(value); if (!controller.signal.aborted && next !== 'unknown') setState(next); })
      .catch(error => { if (!controller.signal.aborted) console.warn('[Home] Meet availability check failed:', error); })
      .finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); controller.abort(); };
  }, [enabled, revision]);
  return state;
}
