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

  // Intent: a window whose map is cut off at the output cap is mapped as two halves, not the end of the run.
  it('splits a truncated window in half and keeps exact global evidence for each half', async () => {
    const source = makeSource(6, 10);
    const truncated = Object.assign(new Error('cut off'), { code: 'invalid_completion', stopReason: 'max_tokens' });
    const generateWindow = vi.fn(async (winSource) => {
      if (winSource.finalTokens.length > 2) throw truncated;
      return { ...fakeWindowMap(winSource, winSource.recordingId), backend: 'anthropic', model: 'claude-synthetic' };
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await runLongTranscriptPipeline({ source, routes: [], generateWindow, intervalMs: 0,
      windowOptions: { maxWords: 40, maxSeconds: 10_000 } });
    // Windows of 4 + 2 turns: the first is truncated, halved into 2 + 2.
    expect(generateWindow.mock.calls.map(([w]) => w.finalTokens.length)).toEqual([4, 2, 2, 2]);
    expect(generateWindow.mock.calls[1][0].finalTokens[0].text.startsWith('\n')).toBe(false);
    expect(result.windowCount).toBe(3);
    expect(result.bundle.graph_data.filter(n => n.semantic_level === 1).map(n => [n.id, n.source_ref.utterance_ids]))
      .toEqual([['w1a-chunk-1', ['utterance-0001']], ['w1b-chunk-1', ['utterance-0003']], ['w2-chunk-1', ['utterance-0005']]]);
    const events = info.mock.calls.map(([line]) => line.split(') ').at(-1));
    expect(events).toEqual(['start', 'split', 'start', 'done', 'start', 'done', 'start', 'done']);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/word\d/);
  });

  it('stops on a truncated window that cannot be split further and on other failures', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const truncated = Object.assign(new Error('cut off'), { stopReason: 'max_tokens' });
    const always = vi.fn(async () => { throw truncated; });
    await expect(runLongTranscriptPipeline({ source: makeSource(8, 10), routes: [], generateWindow: always, intervalMs: 0,
      windowOptions: { maxWords: 1000, maxSeconds: 10_000 } })).rejects.toBe(truncated);
    expect(always.mock.calls.map(([w]) => w.finalTokens.length)).toEqual([8, 4, 2]);
    const invalid = new Error('tier rule');
    const once = vi.fn(async () => { throw invalid; });
    await expect(runLongTranscriptPipeline({ source: makeSource(8, 10), routes: [], generateWindow: once, intervalMs: 0,
      windowOptions: { maxWords: 1000, maxSeconds: 10_000 } })).rejects.toBe(invalid);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('merges a single window without adding a w1- prefix', () => {
    const source = makeSource(2, 5);
    const [win] = splitSourceIntoWindows(source, { maxWords: 100, maxSeconds: 1000 });
    const merged = mergeWindowedGraphs(source, [{ window: win, bundle: fakeWindowMap(win.source, 'solo').bundle }], { title: 'Solo' });
    expect(merged.bundle.graph_data.map(n => n.id)).toEqual(['topic-1', 'chunk-1']);
  });
});
