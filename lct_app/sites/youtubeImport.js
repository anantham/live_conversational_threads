import { resolveIdentity } from './auth.js';
import { openRouterPolicy } from './openRouterPolicy.js';
import {
  YouTubeImportError, MAX_CAPTION_BYTES, chooseCaptionTrack, durationSeconds, parseCaptionXml,
  parseYouTubeImportUrl, validVideoId,
} from '../src/services/youtubeImport.js';

// Reads public YouTube pages on the visitor's behalf: a playlist's video list and one video's captions.
// Fixed host, ids validated before they reach a URL, every upstream body size-capped, no upstream text
// ever returned to the visitor. This holds no state and spends nothing.
const PREFIX = '/api/cloud/youtube';
const CONSENT_HEADER = 'x-lct-youtube-import';
const HOST = 'https://www.youtube.com';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_VIDEOS = 300;
const MAX_PAGES = 4;
const MAX_JSON_BYTES = 6 * 1024 * 1024;
const MAX_NODES = 400_000;

const STATUS = { empty: 400, invalid_link: 400, unreadable_playlist: 400, sign_in: 401, consent: 403, unavailable: 404,
  no_captions: 404, live: 422, youtube_blocked: 502, upstream_failed: 502, captions_unreadable: 502, captions_empty: 502,
  captions_too_large: 413, timeout: 504, cancelled: 408 };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function failure(error, stage) {
  const known = error instanceof YouTubeImportError;
  const code = known ? error.code : 'upstream_failed';
  // Diagnostics name the stage and class only: never a URL, a response body or visitor text.
  console.error('[youtube-import] failed', { stage, code, name: error?.name });
  return json(STATUS[code] || 502, { error: code, message: known ? error.message : 'YouTube could not be reached. Nothing was imported; try again shortly.' });
}

// `consume` reads the body inside the same deadline and abort wiring as the request itself, so a response
// that sends headers and then stalls is cut off by the timeout instead of hanging.
async function upstream(url, init, parent, ms, stage, consume) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, ms);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new YouTubeImportError('upstream_failed', 'YouTube redirected the request. Nothing was imported.');
    return consume ? await consume(response) : response;
  } catch (error) {
    if (error instanceof YouTubeImportError) throw error;
    if (parent?.aborted) throw new YouTubeImportError('cancelled', 'The import was cancelled.');
    if (controller.signal.aborted) throw new YouTubeImportError('timeout', 'YouTube took too long to answer. Nothing was imported; try again.');
    console.error('[youtube-import] transport', { stage, name: error?.name });
    throw new YouTubeImportError('upstream_failed', 'YouTube could not be reached. Nothing was imported; try again shortly.');
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { void response.body?.cancel().catch(() => {}); throw new YouTubeImportError('captions_too_large', 'YouTube sent more data than this import accepts.'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { void reader.cancel().catch(() => {}); throw new YouTubeImportError('captions_too_large', 'YouTube sent more data than this import accepts.'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function innertube(path, body, ua, parent, stage) {
  return upstream(`${HOST}/youtubei/v1/${path}?prettyPrint=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'Accept-Language': 'en' }, body: JSON.stringify(body),
  }, parent, 12_000, stage, async response => {
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new YouTubeImportError('upstream_failed', 'YouTube could not be reached. Nothing was imported; try again shortly.'); }
    const text = await readCapped(response, MAX_JSON_BYTES);
    try { return JSON.parse(text); }
    catch { throw new YouTubeImportError('upstream_failed', 'YouTube answered in a form this import could not read.'); }
  });
}

/** Visit parsed JSON in document order, iteratively, with a depth and node limit: the response is not trusted. */
function* nodes(root) {
  const stack = [[root, 0]];
  let seen = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object' || depth > 60) continue;
    // Failing loudly beats silently dropping the rest of a playlist.
    if (++seen > MAX_NODES) throw new YouTubeImportError('upstream_failed', 'YouTube sent a page larger than this import reads. Nothing was imported.');
    yield node;
    // Pushed last-to-first so children are visited in document order: a playlist's order is its meaning.
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push([children[index], depth + 1]);
  }
}

const textOf = value => typeof value === 'string' ? value : value?.simpleText ?? value?.runs?.map(run => run.text).join('') ?? value?.content ?? null;

// The playlist's own list, not the sidebar, recommendations or filter chips around it. A continuation
// response carries its items in its actions. An unfamiliar shape falls back to the whole response.
function listScope(data) {
  return data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?? data?.onResponseReceivedActions ?? data?.onResponseReceivedEndpoints ?? data;
}

/** Pull videos, the title and the next-page token from one browse response (new and legacy shapes). */
export function extractPlaylistPage(data) {
  const videos = [];
  let title = null, continuation = null;
  for (const node of nodes(data)) {
    title = textOf(node.playlistMetadataRenderer?.title) ?? textOf(node.pageHeaderRenderer?.pageTitle);
    if (title !== null) break;
  }
  for (const node of nodes(listScope(data))) {
    const lockup = node.lockupViewModel;
    if (lockup && validVideoId(lockup.contentId) && String(lockup.contentType || '').includes('VIDEO')) {
      let length = null;
      for (const inner of nodes(lockup.contentImage)) {
        const label = inner.thumbnailBadgeViewModel?.text;
        if (length === null && typeof label === 'string') length = durationSeconds(label);
      }
      videos.push({ id: lockup.contentId, title: textOf(lockup.metadata?.lockupMetadataViewModel?.title), duration_seconds: length });
    }
    const legacy = node.playlistVideoRenderer;
    if (legacy && validVideoId(legacy.videoId) && legacy.isPlayable !== false) {
      const length = Number(legacy.lengthSeconds);
      videos.push({ id: legacy.videoId, title: textOf(legacy.title), duration_seconds: Number.isFinite(length) && length > 0 ? length : null });
    }
    const token = node.continuationCommand?.token ?? node.nextContinuationData?.continuation;
    if (continuation === null && typeof token === 'string') continuation = token;
  }
  return { videos, title: typeof title === 'string' ? title.slice(0, 200) : null, continuation };
}

async function resolvePlaylist(playlistId, selected, parent) {
  const context = { client: { clientName: 'WEB', clientVersion: '2.20251120.01.00', hl: 'en' } };
  const seen = new Map();
  let title = null, token = null, truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await innertube('browse', token ? { context, continuation: token } : { context, browseId: 'VL' + playlistId }, WEB_UA, parent, 'playlist');
    const found = extractPlaylistPage(data);
    title ??= found.title;
    for (const video of found.videos) if (!seen.has(video.id)) seen.set(video.id, video);
    token = found.continuation;
    if (seen.size >= MAX_VIDEOS) { truncated = Boolean(token) || seen.size > MAX_VIDEOS; break; }
    if (!token) break;
    if (page === MAX_PAGES - 1) { truncated = true; break; }
  }
  if (!seen.size) throw new YouTubeImportError('unavailable', 'That playlist is private, empty or unavailable. Only public and unlisted playlists can be read.');
  const videos = [...seen.values()].slice(0, MAX_VIDEOS).map(video => ({
    id: video.id, title: (video.title || '').slice(0, 200) || null, duration_seconds: video.duration_seconds }));
  return { kind: 'playlist', playlist_id: playlistId, title, videos, truncated, selected_video_id: selected && videos.some(video => video.id === selected) ? selected : null };
}

async function resolveVideo(videoId, parent) {
  const target = `${HOST}/watch?v=${videoId}`;
  // The title is a courtesy. oEmbed refuses videos whose owner disabled embedding, and those still have
  // captions, so only the transcript step decides whether a video is importable.
  let title = null;
  try {
    title = await upstream(`${HOST}/oembed?format=json&url=${encodeURIComponent(target)}`, { headers: { 'User-Agent': WEB_UA } }, parent, 8000, 'oembed', async response => {
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return null; }
      try { return textOf(JSON.parse(await readCapped(response, 64 * 1024)).title)?.slice(0, 200) || null; } catch { return null; }
    });
  } catch (error) { if (error?.code === 'cancelled') throw error; }
  return { kind: 'video', playlist_id: null, title, videos: [{ id: videoId, title, duration_seconds: null }], truncated: false, selected_video_id: videoId };
}

function captionUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== HOST || url.pathname !== '/api/timedtext' || url.username || url.password) return null;
    url.searchParams.delete('fmt');
    return url.toString();
  } catch { return null; }
}

async function transcript(videoId, parent) {
  const data = await innertube('player', { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en' } }, videoId },
    ANDROID_UA, parent, 'player');
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    // LOGIN_REQUIRED covers private and age-restricted videos and also YouTube refusing a datacenter caller.
    if (status === 'LOGIN_REQUIRED') throw new YouTubeImportError('youtube_blocked', 'YouTube would not release this video to the Site. It may be private or age-restricted, or YouTube may be refusing automated requests from the Site.');
    throw new YouTubeImportError('unavailable', 'That video is private, removed or unavailable.');
  }
  if (data.videoDetails?.isLive || (data.videoDetails?.isLiveContent && data.videoDetails?.isUpcoming)) {
    throw new YouTubeImportError('live', 'Live streams cannot be imported until they have ended and have captions.');
  }
  const chosen = chooseCaptionTrack(data.captions?.playerCaptionsTracklistRenderer?.captionTracks, 'en');
  if (!chosen) throw new YouTubeImportError('no_captions', 'This video has no captions, so there is no transcript to import. Audio import can transcribe a downloaded copy.');
  const url = captionUrl(chosen.track.baseUrl);
  if (!url) throw new YouTubeImportError('upstream_failed', 'YouTube answered in a form this import could not read.');
  const cues = await upstream(url, { headers: { 'User-Agent': ANDROID_UA, 'Accept-Language': 'en' } }, parent, 20_000, 'captions', async response => {
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new YouTubeImportError('upstream_failed', 'YouTube could not be reached. Nothing was imported; try again shortly.'); }
    return parseCaptionXml(await readCapped(response, MAX_CAPTION_BYTES));
  });
  const length = Number(data.videoDetails?.lengthSeconds);
  return {
    video: { id: videoId, title: textOf(data.videoDetails?.title)?.slice(0, 200) || null, length_seconds: Number.isFinite(length) && length > 0 ? length : null },
    caption: { language: String(chosen.track.languageCode || '').slice(0, 16) || null, kind: chosen.kind },
    cues,
  };
}

export async function handleYouTubeImport(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== `${PREFIX}/resolve` && url.pathname !== `${PREFIX}/transcript`) return null;
  const stage = url.pathname.slice(PREFIX.length + 1);
  try {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    // A custom header makes a cross-site *browser* call preflight, which this Worker never approves. It does not
    // stop a script that sets the header itself; that is the accepted exposure of the public audience.
    if (request.headers.get(CONSENT_HEADER) !== 'v1') throw new YouTubeImportError('consent', 'Start the import from this Site.');
    const audience = openRouterPolicy(env).audience;
    if (audience !== 'public' && !await resolveIdentity(request, env)) {
      throw new YouTubeImportError('sign_in', 'Sign in to import from YouTube. Public browsing is still available.');
    }
    if (stage === 'resolve') {
      const parsed = parseYouTubeImportUrl(url.searchParams.get('url'));
      return json(200, parsed.kind === 'playlist' ? await resolvePlaylist(parsed.playlistId, parsed.videoId, request.signal) : await resolveVideo(parsed.videoId, request.signal));
    }
    const id = url.searchParams.get('v');
    if (!validVideoId(id)) throw new YouTubeImportError('invalid_link', 'That video id is not valid.');
    return json(200, await transcript(id, request.signal));
  } catch (error) { return failure(error, stage); }
}
