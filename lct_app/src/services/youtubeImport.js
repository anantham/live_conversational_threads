// Pure helpers for importing a YouTube transcript. Shared by the Site Worker (which talks to YouTube)
// and the browser (which classifies pasted links and builds transcript tokens). No network access here.
//
// Test Intent (tests/intent/youtube-import.md): a pasted link is classified without trusting it; caption
// XML becomes timed tokens the existing transcript builder accepts; nothing here fetches or logs.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{13,64}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
// Per-user or generated lists that cannot be read without a signed-in session or change on every visit.
const UNREADABLE_PLAYLIST = /^(?:RD|LL|WL|FL)/;
// createRecordingTranscript accepts at most 8,192 tokens; stay below it so a long video still imports.
export const MAX_IMPORT_TOKENS = 8000;
export const MAX_CAPTION_BYTES = 4 * 1024 * 1024;

export class YouTubeImportError extends Error {
  constructor(code, message) { super(message); this.name = 'YouTubeImportError'; this.code = code; }
}

/**
 * Classify a pasted YouTube link. Returns { kind: 'video', videoId } or
 * { kind: 'playlist', playlistId, videoId } (videoId is the video the link pointed at, or null).
 * Throws YouTubeImportError with a fixed, user-readable message for anything else.
 */
export function parseYouTubeImportUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new YouTubeImportError('empty', 'Paste a YouTube video or playlist link.');
  if (text.length > 500) throw new YouTubeImportError('invalid_link', 'That link is too long to be a YouTube link.');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text); }
  catch { throw new YouTubeImportError('invalid_link', 'That does not look like a YouTube link.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new YouTubeImportError('invalid_link', 'That does not look like a YouTube link.');
  }
  const host = url.hostname.toLowerCase();
  let videoId = null;
  if (host === 'youtu.be') videoId = url.pathname.split('/')[1] || null;
  else if (HOSTS.has(host)) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else {
      const match = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
      if (match) videoId = match[1];
      else if (url.pathname !== '/playlist') throw new YouTubeImportError('invalid_link', 'Paste a YouTube video link (watch, youtu.be, shorts or live) or a playlist link.');
    }
  } else throw new YouTubeImportError('invalid_link', 'Only youtube.com and youtu.be links can be imported.');
  if (videoId !== null && !VIDEO_ID.test(videoId)) throw new YouTubeImportError('invalid_link', 'That video link has no valid video id.');

  const lists = url.searchParams.getAll('list');
  if (lists.length > 1) throw new YouTubeImportError('invalid_link', 'That link names more than one playlist.');
  const playlistId = lists[0] ?? null;
  if (playlistId !== null) {
    if (UNREADABLE_PLAYLIST.test(playlistId)) {
      if (videoId) return { kind: 'video', videoId }; // an auto-generated mix still points at one real video
      throw new YouTubeImportError('unreadable_playlist', 'Auto-generated mixes, Liked videos and Watch later cannot be read. Paste a saved playlist or a single video.');
    }
    if (!PLAYLIST_ID.test(playlistId)) throw new YouTubeImportError('invalid_link', 'That playlist id is not valid.');
    return { kind: 'playlist', playlistId, videoId };
  }
  if (videoId) return { kind: 'video', videoId };
  throw new YouTubeImportError('invalid_link', 'Paste a YouTube video or playlist link.');
}

export function validVideoId(value) { return typeof value === 'string' && VIDEO_ID.test(value); }
export function validPlaylistId(value) { return typeof value === 'string' && PLAYLIST_ID.test(value) && !UNREADABLE_PLAYLIST.test(value); }

/** "1:47:28" or "12:03" -> seconds, or null when unreadable. */
export function durationSeconds(label) {
  if (typeof label !== 'string' || !/^\d{1,3}(?::\d{1,2}){1,2}$/.test(label.trim())) return null;
  const parts = label.trim().split(':').map(Number);
  if (parts.slice(1).some(part => part > 59)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds), h = Math.floor(whole / 3600), m = Math.floor(whole % 3600 / 60), s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(value) {
  // A numeric reference can name any code point; refuse the ones that are not text.
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(\w+));/g, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name] ?? whole;
    const point = dec ? Number(dec) : parseInt(hex, 16);
    return point > 31 && point < 0x110000 && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

/**
 * Choose which caption track to import: a human-written track in the requested language, then an
 * automatic one in that language, then a human-written track in any language, then the first track.
 * Returns { track, kind: 'manual' | 'auto' } or null when the video has no captions.
 */
export function chooseCaptionTrack(tracks, language = 'en') {
  const list = (Array.isArray(tracks) ? tracks : []).filter(track => track && typeof track.baseUrl === 'string');
  if (!list.length) return null;
  const same = track => String(track.languageCode || '').toLowerCase().split('-')[0] === language;
  const auto = track => track.kind === 'asr';
  const pick = list.find(track => same(track) && !auto(track)) || list.find(track => same(track))
    || list.find(track => !auto(track)) || list[0];
  return { track: pick, kind: auto(pick) ? 'auto' : 'manual' };
}

function plainText(inner) {
  return decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse YouTube caption XML (the srv3 `<p t d><s>` form and the older `<text start dur>` form)
 * into cues: [{ start_ms, end_ms, text }]. Empty and line-break-only cues are dropped; a cue ends
 * no later than the next one starts, because automatic captions overlap while words are revealed.
 */
export function parseCaptionXml(xml) {
  if (typeof xml !== 'string') throw new YouTubeImportError('captions_unreadable', 'The captions could not be read.');
  if (xml.length > MAX_CAPTION_BYTES) throw new YouTubeImportError('captions_too_large', 'The captions are larger than this import can accept.');
  const cues = [];
  const modern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (let match; (match = modern.exec(xml));) {
    const start = /\bt="(\d+)"/.exec(match[1]), length = /\bd="(\d+)"/.exec(match[1]);
    const text = plainText(match[2]);
    if (start && text) cues.push({ start_ms: Number(start[1]), end_ms: Number(start[1]) + (length ? Number(length[1]) : 0), text });
  }
  if (!cues.length) {
    const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    for (let match; (match = legacy.exec(xml));) {
      const start = /\bstart="([\d.]+)"/.exec(match[1]), length = /\bdur="([\d.]+)"/.exec(match[1]);
      const text = plainText(match[2]);
      if (start && text) {
        const from = Math.round(Number(start[1]) * 1000);
        cues.push({ start_ms: from, end_ms: from + Math.round(Number(length?.[1] || 0) * 1000), text });
      }
    }
  }
  cues.sort((a, b) => a.start_ms - b.start_ms);
  for (let index = 0; index < cues.length; index += 1) {
    const next = cues[index + 1];
    if (next && cues[index].end_ms > next.start_ms) cues[index].end_ms = next.start_ms;
    if (cues[index].end_ms < cues[index].start_ms) cues[index].end_ms = cues[index].start_ms;
  }
  if (!cues.length) throw new YouTubeImportError('captions_empty', 'The captions contain no text.');
  return cues;
}

/**
 * Turn cues into the timed tokens createRecordingTranscript accepts: one token per cue, each after
 * the first starting with a space so words never fuse. A video with more cues than the transcript
 * builder allows has neighbouring cues merged, keeping the first start and the last end.
 */
export function cuesToTokens(cues, limit = MAX_IMPORT_TOKENS) {
  if (!Array.isArray(cues) || !cues.length) throw new YouTubeImportError('captions_empty', 'The captions contain no text.');
  const group = Math.ceil(cues.length / limit);
  const tokens = [];
  for (let index = 0; index < cues.length; index += group) {
    const slice = cues.slice(index, index + group);
    tokens.push({
      text: (tokens.length ? ' ' : '') + slice.map(cue => cue.text).join(' '),
      startMs: slice[0].start_ms,
      endMs: slice[slice.length - 1].end_ms,
    });
  }
  return tokens;
}
