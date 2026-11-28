import { useEffect, useState } from 'react';
import { readLocalConversation } from '../services/cloud/localConversationStore';

/**
 * The audio blob of a conversation saved in this browser, only when it can be played against the map's
 * timeline: a single, complete part. A paused recording (or a meeting's live chunks) is stored as several
 * parts with no record of where each one starts, so playing one part against the conversation's times
 * would point at the wrong words.
 */
export function playableLocalAudio(saved) {
  const audio = saved?.audio;
  if (!audio?.complete || !Array.isArray(audio.segments) || audio.segments.length !== 1) return null;
  const blob = audio.segments[0]?.blob;
  return blob?.size ? blob : null;
}

/**
 * An object URL for that audio. Keyed on the conversation id, not on the map object, so editing the map
 * (renaming a speaker, adding a reaction) does not stop playback or read the store again.
 */
export function useLocalConversationAudio(conversationId, enabled = true, read = readLocalConversation) {
  // The URL is kept with the conversation it belongs to, so the render after a switch never returns
  // the previous conversation's (already revoked) URL.
  const [loaded, setLoaded] = useState({ id: null, url: '' });
  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    let cancelled = false, objectUrl = '';
    Promise.resolve()
      .then(() => read(conversationId))
      .then(saved => {
        const blob = playableLocalAudio(saved);
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ id: conversationId, url: objectUrl });
      })
      .catch(() => { /* local audio is optional */ });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [conversationId, enabled, read]);
  return enabled && conversationId && loaded.id === conversationId ? loaded.url : '';
}
