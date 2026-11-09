import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationArchive } from '../services/cloud/conversationArchive.js';
import { getConversationRetention, setConversationRetention } from '../services/cloud/conversationRetention.js';

export function useConversationArchive() {
  const [preference, setPreference] = useState(getConversationRetention);
  const [preferenceError, setPreferenceError] = useState('');
  const [status, setStatus] = useState({ state: 'idle' });
  const writer = useRef(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; void writer.current?.flush(); }; }, []);
  const begin = useCallback((recording, mode) => {
    void writer.current?.flush();
    let archive;
    archive = new ConversationArchive(recording, { mode, onStatus: value => { if (alive.current && writer.current === archive) setStatus(value); } });
    writer.current = archive;
    setStatus({ state: mode === 'ephemeral' ? 'ephemeral' : 'waiting' });
  }, []);
  const update = useCallback(patch => writer.current?.update(patch), []);
  const append = useCallback(chunk => writer.current?.append(chunk), []);
  const restored = useCallback(value => {
    void writer.current?.flush();
    const { id, recording, title, transcript, map, stage, segments, updatedAt, revision } = value;
    let archive;
    archive = new ConversationArchive(recording, { initial: { id, recording, title, transcript, map, stage, segments, updatedAt, revision },
      onStatus: next => { if (alive.current && writer.current === archive) setStatus(next); } });
    writer.current = archive; setStatus({ state: 'saved' });
  }, []);
  const retry = useCallback(() => { setStatus({ state: 'saving' }); void writer.current?.flush({ retry: true }); }, []);
  const choose = useCallback(mode => {
    setPreference(mode);
    try { setConversationRetention(mode); setPreferenceError(''); }
    catch { setPreferenceError('This choice applies in this tab, but this browser could not remember it for your next visit.'); }
  }, []);
  return { preference, preferenceError, choose, status, begin, update, append, restored, retry };
}
