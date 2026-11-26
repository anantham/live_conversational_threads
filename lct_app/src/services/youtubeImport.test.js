// @vitest-environment node
// Test intent: tests/intent/youtube-import.md. Synthetic captions only; no network.
import { describe, expect, it } from 'vitest';
import {
  YouTubeImportError, MAX_IMPORT_TOKENS, chooseCaptionTrack, cuesToTokens, durationSeconds, formatDuration,
  parseCaptionXml, parseYouTubeImportUrl,
} from './youtubeImport.js';
import { createRecordingTranscript } from './cloud/recordingTranscript.js';

const VIDEO = 'kvL2PFa2fyM', LIST = 'PLGtOBavor_HPxWL2SMqaOczXLRZq0Ru7y';
const fails = (value, code) => {
  try { parseYouTubeImportUrl(value); } catch (error) { expect(error).toBeInstanceOf(YouTubeImportError); expect(error.code).toBe(code); return; }
  throw new Error(`expected ${String(value)} to be refused with ${code}`);
};

describe('parseYouTubeImportUrl', () => {
  it('reads a plain video link in every common shape', () => {
    for (const link of [`https://www.youtube.com/watch?v=${VIDEO}`, `https://youtu.be/${VIDEO}`, `https://youtu.be/${VIDEO}?t=42`,
      `https://m.youtube.com/watch?v=${VIDEO}&t=9s`, `https://music.youtube.com/watch?v=${VIDEO}`, `https://www.youtube.com/shorts/${VIDEO}`,
      `https://www.youtube.com/live/${VIDEO}`, `https://www.youtube.com/embed/${VIDEO}`, `www.youtube.com/watch?v=${VIDEO}`,
      `  youtube.com/watch?v=${VIDEO}  `, `http://youtube.com/watch?v=${VIDEO}`, `https://www.youtube.com/shorts/${VIDEO}/`,
      `https://www.youtube.com/live/${VIDEO}/`, `https://www.youtube.com/watch/?v=${VIDEO}`]) {
      expect(parseYouTubeImportUrl(link), link).toEqual({ kind: 'video', videoId: VIDEO });
    }
  });

  it('reads a playlist link, and remembers which video a watch link pointed at', () => {
    expect(parseYouTubeImportUrl(`https://www.youtube.com/playlist?list=${LIST}`)).toEqual({ kind: 'playlist', playlistId: LIST, videoId: null });
    expect(parseYouTubeImportUrl(`https://www.youtube.com/watch?v=${VIDEO}&list=${LIST}`)).toEqual({ kind: 'playlist', playlistId: LIST, videoId: VIDEO });
    expect(parseYouTubeImportUrl(`https://youtu.be/${VIDEO}?list=${LIST}`)).toEqual({ kind: 'playlist', playlistId: LIST, videoId: VIDEO });
    expect(parseYouTubeImportUrl(`https://www.youtube.com/playlist/?list=${LIST}`)).toEqual({ kind: 'playlist', playlistId: LIST, videoId: null });
  });

  it('treats an auto-generated mix as the single video it points at, and refuses a mix alone', () => {
    expect(parseYouTubeImportUrl(`https://www.youtube.com/watch?v=${VIDEO}&list=RDkvL2PFa2fyM`)).toEqual({ kind: 'video', videoId: VIDEO });
    fails('https://www.youtube.com/playlist?list=RDkvL2PFa2fyMxyz', 'unreadable_playlist');
    fails('https://www.youtube.com/playlist?list=WL', 'unreadable_playlist');
    fails(`https://www.youtube.com/playlist?list=LL${'a'.repeat(20)}`, 'unreadable_playlist');
  });

  it('refuses anything that is not a YouTube video or playlist link, with a fixed message', () => {
    fails('', 'empty'); fails('   ', 'empty'); fails(undefined, 'empty');
    fails('hello there', 'invalid_link');
    fails('https://example.com/watch?v=' + VIDEO, 'invalid_link');
    fails('https://youtube.com.evil.example/watch?v=' + VIDEO, 'invalid_link');
    fails('https://evil.example/https://www.youtube.com/watch?v=' + VIDEO, 'invalid_link');
    fails('javascript:alert(1)', 'invalid_link');
    fails('https://user:pw@www.youtube.com/watch?v=' + VIDEO, 'invalid_link');
    fails('https://www.youtube.com:8443/watch?v=' + VIDEO, 'invalid_link');
    fails('https://www.youtube.com/watch?v=short', 'invalid_link');
    fails('https://www.youtube.com/watch', 'invalid_link');
    fails('https://www.youtube.com/@somechannel', 'invalid_link');
    fails('https://www.youtube.com/playlist', 'invalid_link');
    fails(`https://www.youtube.com/watch?v=${VIDEO}&list=${LIST}&list=${LIST}`, 'invalid_link');
    fails('https://www.youtube.com/playlist?list=bad!id', 'invalid_link');
    fails('https://www.youtube.com/watch?v=' + VIDEO + '&x=' + 'a'.repeat(600), 'invalid_link');
  });
});

describe('durations', () => {
  it('reads and formats clock labels', () => {
    expect(durationSeconds('1:47:28')).toBe(6448);
    expect(durationSeconds('12:03')).toBe(723);
    expect(durationSeconds('0:09')).toBe(9);
    for (const bad of ['', 'LIVE', '1:75', '99', null, '1:2:3:4']) expect(durationSeconds(bad), String(bad)).toBeNull();
    expect(formatDuration(6448)).toBe('1:47:28');
    expect(formatDuration(723)).toBe('12:03');
    expect(formatDuration(-1)).toBe('');
  });
});

describe('chooseCaptionTrack', () => {
  const manualEn = { baseUrl: 'u1', languageCode: 'en' }, autoEn = { baseUrl: 'u2', languageCode: 'en', kind: 'asr' };
  const manualFr = { baseUrl: 'u3', languageCode: 'fr' }, autoDe = { baseUrl: 'u4', languageCode: 'de', kind: 'asr' };
  it('prefers a written track in the language, then an automatic one, then any written track, then the first', () => {
    expect(chooseCaptionTrack([autoEn, manualFr, manualEn])).toEqual({ track: manualEn, kind: 'manual' });
    expect(chooseCaptionTrack([manualFr, autoEn])).toEqual({ track: autoEn, kind: 'auto' });
    expect(chooseCaptionTrack([autoDe, manualFr])).toEqual({ track: manualFr, kind: 'manual' });
    expect(chooseCaptionTrack([autoDe])).toEqual({ track: autoDe, kind: 'auto' });
    expect(chooseCaptionTrack([{ baseUrl: 'x', languageCode: 'en-GB' }]).track.baseUrl).toBe('x');
  });
  it('returns null when there is nothing usable', () => {
    for (const none of [undefined, null, [], [{ languageCode: 'en' }], 'nope']) expect(chooseCaptionTrack(none)).toBeNull();
  });
});

// Mirrors the structure YouTube serves for automatic captions: word spans, overlapping windows and
// line-break-only paragraphs between cues.
const asr = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><ws id="0"/></head><body>
<p t="0" d="3240" w="1"><s ac="240">we</s><s t="480" ac="243"> live</s><s t="719" ac="248"> in</s></p>
<p t="2210" d="1030" w="1" a="1">
</p>
<p t="2220" d="3900" w="1"><s ac="248">information</s><s t="400"> that&#39;s</s> &amp; more</p>
<p t="6120" d="1000" w="1"><s>second</s> <s>cue</s></p>
</body></timedtext>`;

describe('parseCaptionXml', () => {
  it('turns automatic captions into cues, dropping empty paragraphs and decoding entities', () => {
    expect(parseCaptionXml(asr)).toEqual([
      { start_ms: 0, end_ms: 2220, text: 'we live in' },
      { start_ms: 2220, end_ms: 6120, text: "information that's & more" },
      { start_ms: 6120, end_ms: 7120, text: 'second cue' },
    ]);
  });
  it('reads the older text-element form', () => {
    const legacy = '<transcript><text start="1.5" dur="2.25">Hello &quot;there&quot;</text><text start="0" dur="1">first</text></transcript>';
    expect(parseCaptionXml(legacy)).toEqual([
      { start_ms: 0, end_ms: 1000, text: 'first' }, { start_ms: 1500, end_ms: 3750, text: 'Hello "there"' }]);
  });
  it('never turns a numeric reference into a control character or a lone surrogate', () => {
    const [cue] = parseCaptionXml('<p t="0" d="5">a&#0;b&#27;c&#xD800;d&#65;</p>');
    expect(cue.text).toBe('abcdA');
  });
  it('is not fooled by self-closing paragraphs, line-break entities, break tags or escaped formatting', () => {
    const xml = '<timedtext><body><p t="100" d="200" a="1" /><p t="5000" d="1000">actual speech</p>'
      + '<p t="7000" d="500">hello&#10;world</p><p t="8000" d="500">foo<br/>bar</p>'
      + '<p t="9000" d="500">&lt;i&gt;styled&lt;/i&gt; &lt;3 you</p><p t="9500" d="500">a&#127;b&#133;c</p></body></timedtext>';
    expect(parseCaptionXml(xml)).toEqual([
      { start_ms: 5000, end_ms: 6000, text: 'actual speech' }, { start_ms: 7000, end_ms: 7500, text: 'hello world' },
      { start_ms: 8000, end_ms: 8500, text: 'foo bar' }, { start_ms: 9000, end_ms: 9500, text: 'styled <3 you' },
      { start_ms: 9500, end_ms: 10000, text: 'abc' }]);
  });
  it('unwraps captions that are escaped twice, as several real tracks are', () => {
    const [cue] = parseCaptionXml('<timedtext><body><p t="0" d="1000"><s>what&amp;#39;s</s><s> up &amp;amp; down</s><s> &amp;lt;i&amp;gt;x&amp;lt;/i&amp;gt;</s></p></body></timedtext>');
    expect(cue.text).toBe("what's up & down x");
  });
  it('keeps the longer cue when two cues start together', () => {
    const cues = parseCaptionXml('<timedtext><body><p t="1000" d="4000">A</p><p t="1000" d="1000">B</p></body></timedtext>');
    expect(cues.map(cue => [cue.text, cue.start_ms, cue.end_ms]).sort()).toEqual([['A', 1000, 5000], ['B', 1000, 2000]]);
    expect(cuesToTokens(cues, 1)[0].endMs).toBe(5000);
  });
  it('fails loudly when there is no text or the input is not text', () => {
    for (const bad of ['<timedtext></timedtext>', '<timedtext><body><p t="0" d="5">\n</p></body></timedtext>']) {
      expect(() => parseCaptionXml(bad)).toThrow(expect.objectContaining({ code: 'captions_empty' }));
    }
    // A consent or bot-check page is not an empty caption file.
    for (const page of ['', '<!doctype html><html><body>Before you continue to YouTube</body></html>']) {
      expect(() => parseCaptionXml(page)).toThrow(expect.objectContaining({ code: 'captions_unreadable' }));
    }
    expect(() => parseCaptionXml(null)).toThrow(expect.objectContaining({ code: 'captions_unreadable' }));
    expect(() => parseCaptionXml('x'.repeat(4 * 1024 * 1024 + 1))).toThrow(expect.objectContaining({ code: 'captions_too_large' }));
  });
});

describe('cuesToTokens', () => {
  const cues = Array.from({ length: 5 }, (_, index) => ({ start_ms: index * 1000, end_ms: index * 1000 + 900, text: 'word' + index }));
  it('makes one spaced token per cue, so the transcript builder keeps word boundaries', () => {
    const tokens = cuesToTokens(cues);
    expect(tokens).toHaveLength(5);
    expect(tokens.map(token => token.text)).toEqual(['word0', ' word1', ' word2', ' word3', ' word4']);
    expect(tokens[2]).toMatchObject({ startMs: 2000, endMs: 2900 });
  });
  it('merges neighbours when a video has more cues than the builder accepts, losing no words or time', () => {
    const many = Array.from({ length: 20_001 }, (_, index) => ({ start_ms: index * 100, end_ms: index * 100 + 90, text: 'w' + index }));
    const tokens = cuesToTokens(many);
    expect(tokens.length).toBeLessThanOrEqual(MAX_IMPORT_TOKENS);
    expect(tokens[0].startMs).toBe(0);
    expect(tokens.at(-1).endMs).toBe(20_000 * 100 + 90);
    expect(tokens.map(token => token.text).join('').split(/\s+/).length).toBe(20_001);
  });
  it('cannot be made to loop forever by a bad limit', () => {
    for (const limit of [0, -1, NaN, 0.2]) expect(cuesToTokens(cues, limit).length).toBeGreaterThan(0);
  });
  it('refuses an empty list', () => { expect(() => cuesToTokens([])).toThrow(expect.objectContaining({ code: 'captions_empty' })); });
  it('produces tokens the existing transcript builder accepts, with timing it can map', () => {
    const { document } = createRecordingTranscript({ recordingId: 'youtube-' + VIDEO, startedAt: Date.UTC(2026, 10, 25), complete: true,
      finalTokens: cuesToTokens(parseCaptionXml(asr)) });
    expect(document.full_transcript).toBe("we live in information that's & more second cue");
    expect(document.source_tokens[0]).toMatchObject({ start_ms: 0, end_ms: 2220 });
    expect(document.source_tokens.at(-1).end_ms).toBe(7120);
  });
});
