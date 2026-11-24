import { describe, expect, it } from 'vitest';
import { driveTimestampUrl, formatClock, parseGeminiNotesDocument, parsePlainTranscriptText } from './geminiNotesParser.js';

describe('geminiNotesParser', () => {
  it('separates Gemini notes, links, attendee emails, and timestamped raw transcript turns', () => {
    const pages = [
      {
        pageNumber: 1,
        lines: [
          'Please rate the new Quick notes tab by taking a short survey.',
          'Team Catch up',
          'Nov 16, 2026',
          'Quick summary bullet one.',
        ],
        links: ['mailto:alice@example.com', 'mailto:bob@example.com'],
      },
      {
        pageNumber: 2,
        lines: [
          'Invited',
          'Alice, Bob',
          'Meeting records',
          'Transcript',
          'Recording',
          'Summary',
          'Discussed project milestones and timeline.',
          'Next steps',
          'Alice will send the schedule.',
          'Details',
          'Detailed Gemini notes here (00:01:10).',
        ],
        links: [
          'mailto:alice@example.com',
          'https://drive.google.com/file/d/FILE123/view?usp=drive_web',
          'https://docs.google.com/document/d/DOC456/edit?usp=drive_web',
          'https://calendar.google.com/calendar/event?eid=CAL789',
        ],
      },
      {
        pageNumber: 3,
        lines: [
          'Nov 16, 2026',
          'Team Catch up - Transcript',
          '00:00:00',
          'Alice: Hello everyone, let us begin.',
          'Bob: Sounds good to me,',
          'let us review the plan.',
          '00:01:10',
          'Alice: Great, here is part two.',
          'Transcription ended after 00:02:00',
        ],
        links: [],
      },
    ];

    const result = parseGeminiNotesDocument({ filename: 'Team Catch up - 2026_11_16 19_25 IST - Notes by Gemini.pdf', pages });
    expect(result.title).toBe('Team Catch up');
    expect(result.sourceFormat).toBe('google_meet_gemini_pdf');
    expect(result.invitedEmails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(result.recordingUrl).toBe('https://drive.google.com/file/d/FILE123/view?usp=drive_web');
    expect(result.transcriptDocUrl).toBe('https://docs.google.com/document/d/DOC456/edit?usp=drive_web');
    expect(result.calendarEventUrl).toBe('https://calendar.google.com/calendar/event?eid=CAL789');
    expect(result.durationMs).toBe(120_000);
    expect(result.speakers).toEqual(['Alice', 'Bob']);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]).toMatchObject({ speaker: 'Alice', text: 'Hello everyone, let us begin.', startMs: 0 });
    expect(result.turns[1]).toMatchObject({ speaker: 'Bob', text: 'Sounds good to me, let us review the plan.' });
    expect(result.turns[2]).toMatchObject({ speaker: 'Alice', text: 'Great, here is part two.', startMs: 70_000, endMs: 120_000 });
    expect(result.referenceNotes.summary).toContain('Discussed project milestones');
    expect(result.referenceNotes.next_steps).toContain('Alice will send the schedule.');
    expect(result.referenceNotes.quick_notes).toContain('Quick summary bullet one.');
    expect(result.referenceNotes.quick_notes).not.toContain('Please rate the new Quick notes tab');
    expect(result.initialBundle.meeting_metadata.invited_emails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(result.initialBundle.media_refs).toEqual([{
      provider: 'google_drive',
      file_id: 'FILE123',
      view_url: 'https://drive.google.com/file/d/FILE123/view',
      label: 'Meet recording',
    }]);
    expect(result.initialBundle.utterances).toHaveLength(3);
  });

  it('builds Google Drive timestamp jump URLs and formats clocks', () => {
    expect(driveTimestampUrl('https://drive.google.com/file/d/FILE123/view?usp=drive_web', 139_500))
      .toBe('https://drive.google.com/file/d/FILE123/view?usp=drive_web&t=139');
    expect(formatClock(5574_000)).toBe('01:32:54');
  });

  it('parses plain text speaker transcripts', () => {
    const result = parsePlainTranscriptText({
      filename: 'standup.txt',
      text: '00:00:00\nSam: Shipped the parser.\nPat: Testing now.',
    });
    expect(result.sourceFormat).toBe('plain_text_transcript');
    expect(result.speakers).toEqual(['Sam', 'Pat']);
    expect(result.turns).toHaveLength(2);
  });
});
