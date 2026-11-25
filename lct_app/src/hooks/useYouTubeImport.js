import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { YouTubeImportError, cuesToTokens, parseYouTubeImportUrl, validVideoId } from '../services/youtubeImport.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { useConversationArchive } from './useConversationArchive.js';
const empty = () => ({ finalText: '', partialText: '', finalTokens: [], partialTokens: [] });
const HEADERS = { 'x-lct-youtube-import': 'v1' };
// The map pipeline is measured to about 20 minutes of speech; the transcript itself imports at any length.
export const MAP_TESTED_SECONDS = 20 * 60;

async function ask(path, signal) {
  let response;
  try { response = await fetch('/api/cloud/youtube/' + path, { headers: HEADERS, credentials: 'same-origin', cache: 'no-store', signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('The import could not reach the Site. Check your connection and try again. Nothing was imported.');
  }
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : 'The import failed before YouTube answered. Nothing was imported.');
  return body;
}

/** One YouTube link in, one conversation transcript out. Nothing is sent to an AI provider by this hook. */
export function useYouTubeImport() {
  const archive = useConversationArchive(), location = useLocation(), navigate = useNavigate();
  const [link, setLink] = useState(''), [resolved, setResolved] = useState(null), [resolving, setResolving] = useState(false);
  const [recording, setRecording] = useState(null), [transcript, setTranscript] = useState(empty), [map, setMap] = useState(null);
  const [activity, setActivity] = useState(null), [error, setError] = useState(''), [backend, setBackend] = useState('openrouter');
  const [loadingId, setLoadingId] = useState(null);
  const alive = useRef(true), request = useRef(null);
  const localId = new URLSearchParams(location.search).get('local');
  const busy = Boolean(loadingId);

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!localId || recording) return;
    let cancelled = false;
    readLocalConversation(localId).then(value => {
      if (cancelled || !alive.current) return;
      if (!value) throw new Error('This import is not saved in this browser.');
      setRecording(value.recording); setTranscript(value.transcript); setMap(value.map);
      if (value.mapUnreadable) {
        const temporary = { ...value.recording, retention: 'ephemeral' };
        setRecording(temporary); archive.begin(temporary, 'ephemeral');
        setError('The saved map could not be read. Its stored copy is unchanged; this tab will not overwrite it. Download available files before leaving.');
      } else archive.restored(value);
      setActivity({ stage: 'complete', message: 'Opened from this device.' });
    }).catch(failure => { if (!cancelled && alive.current) setError(failure.message); });
    return () => { cancelled = true; };
  }, [localId, recording, archive.restored]);

  const mapReady = useCallback(bundle => { setMap(bundle); archive.update({ map: bundle }); }, [archive.update]);

  const begin = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    return controller;
  }, []);

  async function importVideo(video) {
    if (busy || !validVideoId(video?.id)) return;
    const controller = begin();
    setLoadingId(video.id); setError('');
    try {
      const result = await ask('transcript?v=' + encodeURIComponent(video.id), controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      const tokens = cuesToTokens(result.cues);
      const id = globalThis.crypto?.randomUUID?.();
      if (!id) throw new Error('This browser cannot create a conversation identifier. Nothing was saved.');
      const next = { id, startedAt: Date.now(), transcribe: true, retention: archive.preference, source: 'youtube-import',
        youtube: { video_id: video.id, title: result.video?.title || video.title || null, length_seconds: result.video?.length_seconds ?? null,
          caption_kind: result.caption?.kind ?? null, caption_language: result.caption?.language ?? null } };
      const value = { finalText: tokens.map(token => token.text).join(''), partialText: '', finalTokens: tokens, partialTokens: [] };
      setRecording(next); setTranscript(value); setMap(null);
      archive.begin(next, next.retention);
      archive.update({ transcript: value, stage: 'stopped' });
      navigate(next.retention === 'local' ? '/import-youtube?local=' + id : '/import-youtube', { replace: true });
      setActivity({ stage: 'complete', message: result.caption?.kind === 'auto'
        ? 'Transcript imported from YouTube\'s automatic captions. They have no speaker names and may contain mistakes.'
        : 'Transcript imported from the video\'s captions.' });
    } catch (failure) {
      if (alive.current && failure?.name !== 'AbortError') setError(failure.message);
    } finally { if (alive.current && request.current === controller) { request.current = null; setLoadingId(null); } }
  }

  async function find() {
    if (busy || resolving) return;
    setError(''); setResolved(null);
    try { parseYouTubeImportUrl(link); }
    catch (failure) { setError(failure instanceof YouTubeImportError ? failure.message : 'That does not look like a YouTube link.'); return; }
    const controller = begin();
    setResolving(true);
    let result = null;
    try {
      result = await ask('resolve?url=' + encodeURIComponent(link.trim()), controller.signal);
      if (!alive.current || controller.signal.aborted) result = null;
      else setResolved(result);
    } catch (failure) {
      if (alive.current && failure?.name !== 'AbortError') setError(failure.message);
    } finally { if (alive.current && request.current === controller) { request.current = null; setResolving(false); } }
    // A single video needs no choosing: import its transcript straight away.
    if (result?.kind === 'video') await importVideo(result.videos[0]);
  }

  function cancel() { request.current?.abort(); request.current = null; setLoadingId(null); setResolving(false); }
  return { archive, link, setLink, resolved, resolving, find, importVideo, loadingId, busy, recording, transcript, map, mapReady,
    activity, error, backend, setBackend, cancel };
}
