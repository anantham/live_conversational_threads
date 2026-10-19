import { useCallback, useEffect, useState } from 'react';
import { meetingPath, meetingRequest, meetingTranscript, startMeetingAccess } from '../services/cloud/sitesMeetings.js';

export function useSiteMeeting(id) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    let alive = true, timer;
    const controller = new AbortController();
    async function poll() {
      try {
        meetingPath(id);
        const next = await meetingRequest('/' + id, { signal: controller.signal });
        if (next.meeting?.id !== id) throw new Error('The recorder returned a different meeting reference.');
        if (next.snapshot) next.transcript = meetingTranscript(next.snapshot);
        if (!alive) return;
        setData(next); setError('');
        // Continue through terminal bot state until its audio finalization finishes.
        if (['fatal_error', 'data_deleted'].includes(next.snapshot?.state) || (next.meeting.state === 'ended' && ['not_started', 'complete', 'failed'].includes(next.snapshot?.recording_state))) return;
      } catch (failure) {
        if (!alive) return;
        setError(failure.message || 'Connection interrupted. The recorder may still be running.');
        if ([401, 403, 404].includes(failure.status)) return;
      }
      if (alive) timer = window.setTimeout(poll, 2000);
    }
    try { meetingPath(id); } catch (failure) { setError(failure.message); return () => controller.abort(); }
    void startMeetingAccess(controller.signal).then(() => { if (alive) void poll(); }).catch(failure => { if (alive) setError(failure.message || 'Browser meeting access is unavailable. Your saved local files are unchanged.'); });
    return () => { alive = false; controller.abort(); window.clearTimeout(timer); };
  }, [id, retry]);
  return { data, error, refresh };
}
