import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';

const TIMESTAMP_LINE = /^(\d{2}):(\d{2}):(\d{2})$/;
const TRANSCRIPT_END = /^Transcription ended after (\d{2}):(\d{2}):(\d{2})/i;
const SPEAKER_LINE = /^([^:\n]{1,80}):\s+(.*)$/;
const BOILERPLATE = [
  /^Please rate the new Quick notes tab/i,
  /^You should review Gemini's notes/i,
  /^how Gemini takes notes$/i,
  /^How is the quality of these specific notes\?/i,
  /^feedback, including how helpful the notes were/i,
];

export function parseClockMs(match) {
  const [, h, m, s] = match;
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
}

export function formatClock(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

export function driveTimestampUrl(recordingUrl, ms) {
  if (!recordingUrl) return null;
  try {
    const url = new URL(recordingUrl);
    if (ms != null && Number.isFinite(ms) && ms > 0) {
      url.searchParams.set('t', String(Math.floor(ms / 1000)));
    }
    return url.toString();
  } catch {
    return null;
  }
}

function cleanLine(line) {
  return String(line ?? '').replace(/\u200b/g, '').trim();
}

function isBoilerplate(line) {
  return BOILERPLATE.some(pattern => pattern.test(line));
}

function titleFromFilename(filename) {
  return String(filename || 'Imported transcript')
    .replace(/\.[^.]+$/, '')
    .replace(/\s*-\s*Notes by Gemini$/i, '')
    .replace(/\s*-\s*\d{4}_\d{2}_\d{2}.*$/, '')
    .trim() || 'Imported transcript';
}

function parseDateFromFilenameOrLines(filename, lines) {
  const fnMatch = String(filename || '').match(/(\d{4})_(\d{2})_(\d{2})\s+(\d{2})_(\d{2})/);
  if (fnMatch) {
    const [, y, mo, d, h, mi] = fnMatch;
    const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  for (const line of lines.slice(0, 20)) {
    if (/^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/.test(line)) {
      const parsed = Date.parse(line);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

function extractLinks(pages) {
  const all = pages.flatMap(page => Array.isArray(page.links) ? page.links : []);
  const invitedEmails = [];
  let recordingUrl = null;
  let transcriptDocUrl = null;
  let calendarEventUrl = null;
  for (const uri of all) {
    if (typeof uri !== 'string') continue;
    if (uri.toLowerCase().startsWith('mailto:')) {
      const email = uri.slice(7).split('?')[0].trim().toLowerCase();
      if (email && !invitedEmails.includes(email)) invitedEmails.push(email);
    } else if (!recordingUrl && /^https:\/\/drive\.google\.com\/file\/d\//.test(uri)) {
      recordingUrl = uri;
    } else if (!transcriptDocUrl && /^https:\/\/docs\.google\.com\/document\/d\//.test(uri)) {
      transcriptDocUrl = uri;
    } else if (!calendarEventUrl && /^https:\/\/calendar\.google\.com\/calendar\/event/.test(uri)) {
      calendarEventUrl = uri;
    }
  }
  return { invitedEmails, recordingUrl, transcriptDocUrl, calendarEventUrl };
}

function extractGeminiSections(preTranscriptLines) {
  const cleaned = preTranscriptLines.map(cleanLine).filter(line => line && !isBoilerplate(line));
  const invitedIdx = cleaned.findIndex(line => line === 'Invited');
  const summaryIdx = cleaned.findIndex((line, i) => i >= Math.max(0, invitedIdx) && line === 'Summary');
  const nextStepsIdx = cleaned.findIndex((line, i) => i > Math.max(0, summaryIdx) && line === 'Next steps');
  const detailsIdx = cleaned.findIndex((line, i) => i > Math.max(0, summaryIdx) && line === 'Details');

  const quickNotesLines = invitedIdx > 0 ? cleaned.slice(0, invitedIdx) : [];
  const summaryEnd = [nextStepsIdx, detailsIdx].filter(i => i > summaryIdx).sort((a, b) => a - b)[0] ?? cleaned.length;
  const summaryLines = summaryIdx >= 0 ? cleaned.slice(summaryIdx + 1, summaryEnd) : [];
  const nextStepsEnd = detailsIdx > nextStepsIdx ? detailsIdx : cleaned.length;
  const nextStepsLines = nextStepsIdx >= 0 ? cleaned.slice(nextStepsIdx + 1, nextStepsEnd) : [];
  const detailsLines = detailsIdx >= 0 ? cleaned.slice(detailsIdx + 1) : [];

  return {
    source: 'gemini',
    quick_notes: quickNotesLines.join('\n'),
    summary: summaryLines.join('\n'),
    next_steps: nextStepsLines.join('\n'),
    details: detailsLines.join('\n'),
  };
}

function looksLikeSpeaker(candidate) {
  if (!candidate || candidate.length > 80) return false;
  if (/^https?$/i.test(candidate) || /^\d+$/.test(candidate)) return false;
  if (candidate.includes('http://') || candidate.includes('https://')) return false;
  return true;
}

function parseRawTranscriptLines(lines) {
  const blocks = [];
  let currentBlock = { startMs: 0, turns: [] };
  let durationMs = null;

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line || isBoilerplate(line)) continue;
    const endMatch = line.match(TRANSCRIPT_END);
    if (endMatch) {
      durationMs = parseClockMs(endMatch);
      continue;
    }
    const tsMatch = line.match(TIMESTAMP_LINE);
    if (tsMatch) {
      if (currentBlock.turns.length) blocks.push(currentBlock);
      currentBlock = { startMs: parseClockMs(tsMatch), turns: [] };
      continue;
    }
    const speakerMatch = line.match(SPEAKER_LINE);
    if (speakerMatch && looksLikeSpeaker(speakerMatch[1].trim())) {
      currentBlock.turns.push({ speaker: speakerMatch[1].trim(), text: speakerMatch[2].trim() });
    } else if (currentBlock.turns.length) {
      const last = currentBlock.turns[currentBlock.turns.length - 1];
      last.text = `${last.text} ${line}`.trim();
    } else {
      // Unattributed opening text inside a timestamp block
      currentBlock.turns.push({ speaker: 'Speaker', text: line });
    }
  }
  if (currentBlock.turns.length) blocks.push(currentBlock);

  const turns = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextStart = blocks[i + 1]?.startMs ?? (durationMs != null && durationMs >= block.startMs ? durationMs : block.startMs + 60_000);
    const span = Math.max(0, nextStart - block.startMs);
    const wordCounts = block.turns.map(t => Math.max(1, t.text.split(/\s+/).filter(Boolean).length));
    const totalWords = wordCounts.reduce((a, b) => a + b, 0);
    let offset = 0;
    for (let j = 0; j < block.turns.length; j++) {
      const share = totalWords > 0 ? (wordCounts[j] / totalWords) : 1 / block.turns.length;
      const startMs = Math.round(block.startMs + span * offset);
      offset += share;
      const endMs = Math.round(block.startMs + span * offset);
      turns.push({
        speaker: block.turns[j].speaker,
        text: block.turns[j].text,
        startMs,
        endMs: Math.max(startMs, endMs),
      });
    }
  }
  return { turns, durationMs: durationMs ?? (turns.at(-1)?.endMs ?? 0) };
}

function findTranscriptStart(flatLines) {
  for (let i = 0; i < flatLines.length; i++) {
    const line = cleanLine(flatLines[i]);
    if (/\s-\sTranscript$/i.test(line)) {
      return { startIndex: i + 1, headerTitle: line.replace(/\s-\sTranscript$/i, '').trim() };
    }
  }
  for (let i = 0; i < flatLines.length; i++) {
    if (TIMESTAMP_LINE.test(cleanLine(flatLines[i]))) {
      return { startIndex: i, headerTitle: '' };
    }
  }
  return { startIndex: -1, headerTitle: '' };
}

function buildInitialNodes(utterances) {
  const nodes = [];
  const BUCKET_SECONDS = 300;
  let bucket = [];
  let bucketStart = utterances[0]?.timestamp_start ?? 0;

  const flush = () => {
    if (!bucket.length) return;
    const index = nodes.length + 1;
    const startClock = formatClock((bucket[0].timestamp_start ?? 0) * 1000);
    const endClock = formatClock((bucket.at(-1).timestamp_end ?? bucket.at(-1).timestamp_start ?? 0) * 1000);
    nodes.push({
      id: `segment-${String(index).padStart(3, '0')}`,
      semantic_level: 1,
      semantic_type: 'chunk',
      node_name: `Segment ${index} (${startClock}–${endClock})`,
      source_ref: { utterance_ids: bucket.map(u => u.id) },
    });
    bucket = [];
  };

  for (const utterance of utterances) {
    const t = utterance.timestamp_start ?? bucketStart;
    if (bucket.length && (t - bucketStart >= BUCKET_SECONDS || bucket.length >= 40)) {
      flush();
      bucketStart = t;
    }
    bucket.push(utterance);
  }
  flush();
  return nodes;
}

function buildResult({ filename, title, startedAt, turns, durationMs, links, referenceNotes, sourceFormat }) {
  if (!turns.length) throw new Error('No transcript turns were found in this file.');
  const recordingId = `import-${crypto.randomUUID().slice(0, 12)}`;
  const finalTokens = turns.map((turn, index) => ({
    text: (index === 0 ? '' : '\n') + turn.text,
    speaker: turn.speaker,
    startMs: turn.startMs,
    endMs: turn.endMs,
  }));
  const source = { recordingId, startedAt, finalTokens, complete: true };
  const transcript = createRecordingTranscript(source);
  const speakers = [...new Set(turns.map(turn => turn.speaker))];
  const wordCount = turns.reduce((total, turn) => total + (turn.text.match(/\S+/g)?.length || 0), 0);

  const scaffold = createRecordingThreads({
    ...source,
    graph: {
      metadata: {
        conversation_title: title,
        executive_summary: referenceNotes?.summary || '',
      },
      nodes: buildInitialNodes(transcript.document.utterances),
      edges: [],
      conversation_threads: [],
    },
  });
  const meetingMetadata = {
    source_format: sourceFormat,
    source_filename: filename,
    meeting_date: new Date(startedAt).toISOString(),
    duration_ms: durationMs,
    invited_emails: links.invitedEmails,
    recording_url: links.recordingUrl,
    transcript_doc_url: links.transcriptDocUrl,
    calendar_event_url: links.calendarEventUrl,
    reference_notes: referenceNotes,
  };
  const initialBundle = { ...scaffold.bundle, meeting_metadata: meetingMetadata };
  const initialJson = JSON.stringify(initialBundle, null, 2);

  return {
    title,
    startedAt,
    durationMs,
    speakers,
    wordCount,
    turns,
    source,
    transcript: transcript.document,
    ...links,
    referenceNotes,
    sourceFormat,
    meetingMetadata,
    initialBundle,
    initialJson,
    initialFilename: `${title.replace(/[^a-z0-9-_ ]/gi, '_').trim().slice(0, 60) || 'transcript'}.threads`,
  };
}

export function parseGeminiNotesDocument({ filename = 'transcript.pdf', pages = [] } = {}) {
  const flatLines = pages.flatMap(page => Array.isArray(page.lines) ? page.lines : []);
  const links = extractLinks(pages);
  const { startIndex, headerTitle } = findTranscriptStart(flatLines);
  const preLines = startIndex > 0 ? flatLines.slice(0, startIndex) : [];
  const transcriptLines = startIndex >= 0 ? flatLines.slice(startIndex) : flatLines;
  const isGemini = startIndex > 0 && (
    preLines.some(l => /Notes by Gemini|Quick notes|Meeting records|Suggested next steps|Next steps/i.test(l))
    || Boolean(links.recordingUrl || links.transcriptDocUrl)
  );
  const title = headerTitle || titleFromFilename(filename);
  const startedAt = parseDateFromFilenameOrLines(filename, flatLines);
  const referenceNotes = isGemini ? extractGeminiSections(preLines) : null;
  const { turns, durationMs } = parseRawTranscriptLines(transcriptLines);
  return buildResult({
    filename,
    title,
    startedAt,
    turns,
    durationMs,
    links,
    referenceNotes,
    sourceFormat: isGemini ? 'google_meet_gemini_pdf' : 'pdf_transcript',
  });
}

export function parsePlainTranscriptText({ filename = 'transcript.txt', text = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const title = titleFromFilename(filename);
  const startedAt = parseDateFromFilenameOrLines(filename, lines);
  const { turns, durationMs } = parseRawTranscriptLines(lines);
  return buildResult({
    filename,
    title,
    startedAt,
    turns,
    durationMs,
    links: { invitedEmails: [], recordingUrl: null, transcriptDocUrl: null, calendarEventUrl: null },
    referenceNotes: null,
    sourceFormat: 'plain_text_transcript',
  });
}
