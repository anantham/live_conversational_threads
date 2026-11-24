import { describe, expect, it, vi } from 'vitest';
import { createRecordingThreads } from './recordingThreads.js';
import { mergeWindowedGraphs, runLongTranscriptPipeline, splitSourceIntoWindows } from './longTranscriptPipeline.js';

function makeSource(turnCount = 6, wordsPerTurn = 10) {
  const finalTokens = Array.from({ length: turnCount }, (_, i) => ({
    text: (i === 0 ? '' : '\n') + Array.from({ length: wordsPerTurn }, (_, w) => `word${i}_${w}`).join(' ') + '.',
    speaker: i % 2 === 0 ? 'Alice' : 'Bob',
    startMs: i * 100_000,
    endMs: (i + 1) * 100_000,
  }));
  return { recordingId: 'import-long-test', startedAt: Date.parse('2026-11-16T13:55:00Z'), finalTokens, complete: true };
}

function fakeWindowMap(winSource, label) {
  return createRecordingThreads({
    ...winSource,
    graph: {
      metadata: { conversation_title: `${label} title`, executive_summary: `Summary for ${label}.` },
      nodes: [
        {
          id: 'topic-1',
          semantic_level: 3,
          semantic_type: 'topic',
          node_name: `Topic ${label}`,
          children_ids: ['chunk-1'],
          source_ref: { utterance_ids: ['utterance-0001'] },
        },
        {
          id: 'chunk-1',
          semantic_level: 1,
          semantic_type: 'chunk',
          node_name: `Chunk ${label}`,
          parent_id: 'topic-1',
          source_ref: { utterance_ids: ['utterance-0001'] },
        },
      ],
      edges: [],
      conversation_threads: [{
        id: 'thread-1',
        title: `Thread ${label}`,
        steps: [{ moment_id: 'chunk-1', evidence_utterance_ids: ['utterance-0001'] }],
      }],
    },
  });
}

describe('longTranscriptPipeline', () => {
  it('keeps short transcripts in a single window and splits long ones cleanly', () => {
    const source = makeSource(6, 10);
    expect(splitSourceIntoWindows(source, { maxWords: 200, maxSeconds: 1000 })).toHaveLength(1);
    const windows = splitSourceIntoWindows(source, { maxWords: 25, maxSeconds: 1000 });
    expect(windows).toHaveLength(3);
    expect(windows.flatMap(w => w.globalUtteranceIds)).toEqual([
      'utterance-0001', 'utterance-0002', 'utterance-0003', 'utterance-0004', 'utterance-0005', 'utterance-0006',
    ]);
  });

  it('runs across windows, namespaces node IDs, and remaps evidence to exact global utterance IDs', async () => {
    const source = makeSource(4, 10);
    const generateWindow = vi.fn(async (winSource) => ({
      ...fakeWindowMap(winSource, winSource.recordingId),
      backend: 'anthropic',
      model: 'claude-sonnet-4-5',
    }));
    const progress = [];
    const mediaRefs = [{ provider: 'google_drive', file_id: 'ABC123', view_url: 'https://drive.google.com/file/d/ABC123/view' }];
    const result = await runLongTranscriptPipeline({
      source,
      routes: [{ backend: 'anthropic', key: 'k', model: 'claude-sonnet-4-5' }],
      title: 'Andre Catch up',
      mediaRefs,
      meetingMetadata: { invited_emails: ['a@example.com'] },
      generateWindow,
      intervalMs: 0,
      windowOptions: { maxWords: 20, maxSeconds: 1000 },
      onProgress: event => progress.push(event),
    });

    expect(generateWindow).toHaveBeenCalledTimes(2);
    expect(result.windowCount).toBe(2);
    expect(result.bundle.conversation_title).toBe('Andre Catch up');
    expect(result.bundle.media_refs).toEqual(mediaRefs);
    expect(result.bundle.meeting_metadata).toEqual({ invited_emails: ['a@example.com'] });
    expect(result.bundle.graph_data.map(n => n.id)).toEqual(['w1-topic-1', 'w1-chunk-1', 'w2-topic-1', 'w2-chunk-1']);
    expect(result.bundle.graph_data.find(n => n.id === 'w1-chunk-1').source_ref.utterance_ids).toEqual(['utterance-0001']);
    expect(result.bundle.graph_data.find(n => n.id === 'w2-chunk-1').source_ref.utterance_ids).toEqual(['utterance-0003']);
    expect(result.bundle.conversation_threads.map(t => t.id)).toEqual(['w1-thread-1', 'w2-thread-1']);
    expect(progress.at(-1).phase).toBe('done');
  });

  it('merges a single window without adding a w1- prefix', () => {
    const source = makeSource(2, 5);
    const [win] = splitSourceIntoWindows(source, { maxWords: 100, maxSeconds: 1000 });
    const merged = mergeWindowedGraphs(source, [{ window: win, bundle: fakeWindowMap(win.source, 'solo').bundle }], { title: 'Solo' });
    expect(merged.bundle.graph_data.map(n => n.id)).toEqual(['topic-1', 'chunk-1']);
  });
});
