// @vitest-environment node
// Synthetic provider response -> unchanged artifact validator -> real file reader.
import { describe, expect, it } from 'vitest';
import { recordingThreadsFromOpenRouterResponse } from './openRouterGeneration.js';
import { readThreadsFile } from '../threadsArtifact.js';
import { buildDiscussionModel } from '../../components/discussion/discussionModel.js';

const source = { recordingId: 'synthetic-links', startedAt: Date.UTC(2026, 9, 15), complete: true,
  finalTokens: [{ text: 'A synthetic garden idea.', speaker: 'S1', startMs: 0, endMs: 1200 }] };
const node = (id, level, parent_id, secondary_parent_ids = []) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: id,
  summary: 'Synthetic summary.', source_excerpt: '', source_ref: { utterance_ids: ['utterance-0001'] },
  parent_id, secondary_parent_ids, thread_id: null });
const graph = () => ({ hierarchy_format: 'parent-links-v1',
  metadata: { conversation_title: 'Synthetic hierarchy', executive_summary: 'An overlapping idea.' },
  nodes: [node('moment', 1, 'idea'), node('idea', 2, 'topic', ['other-topic']),
    node('topic', 3, 'theme'), node('other-topic', 3, 'theme'), node('theme', 4, 'arc'), node('arc', 5, null)],
  edges: [], conversation_threads: [{ id: 'path', title: 'Garden idea',
    steps: [{ moment_id: 'moment', evidence_utterance_ids: ['utterance-0001'] }] }] });
const convert = value => recordingThreadsFromOpenRouterResponse({ source, response: {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
} });

describe('Parent-link generation format', () => {
  it('preserves primary, secondary, thread and source meaning through the portable reader', async () => {
    const authored = graph(), before = JSON.stringify(authored);
    const opened = await readThreadsFile(convert(authored).file);
    expect(JSON.stringify(authored)).toBe(before);
    const byId = new Map(opened.graph_data.map(n => [n.id, n]));
    expect(byId.get('idea').parent_id).toBe('topic');
    expect(byId.get('idea').memberships).toEqual([
      { parent_id: 'topic', role: 'primary' }, { parent_id: 'other-topic', role: 'secondary' },
    ]);
    expect(byId.get('topic').children_ids).toEqual(['idea']);
    expect(byId.get('other-topic').children_ids).toEqual(['idea']);
    expect(byId.get('theme').children_ids).toEqual(['topic', 'other-topic']);
    expect(opened.graph_data.map(n => n.semantic_level)).toEqual([1, 2, 3, 3, 4, 5]);
    expect(opened.graph_data.every(n => !('secondary_parent_ids' in n))).toBe(true);
    expect(opened.conversation_threads).toEqual(authored.conversation_threads);
    expect(opened.full_transcript).toBe(source.finalTokens[0].text);
    expect(buildDiscussionModel(opened.graph_data, opened.utterances).utterancesByMoment.get('moment'))
      .toEqual(['utterance-0001']);
  });

  it.each([
    g => { g.nodes[0].parent_id = 'missing'; },
    g => { g.nodes[1].secondary_parent_ids = ['missing']; },
    g => { g.nodes[1].secondary_parent_ids = ['topic']; },
    g => { g.nodes[1].secondary_parent_ids = ['other-topic', 'other-topic']; },
    g => { g.nodes[1].secondary_parent_ids = ['moment']; },
    g => { g.nodes[0].parent_id = 'moment'; },
    g => { g.nodes[1].parent_id = 'moment'; },
    g => { g.nodes[1].id = 'moment'; },
    g => { delete g.nodes[0].parent_id; },
    g => { delete g.nodes[0].secondary_parent_ids; },
    g => { g.nodes[0].children_ids = []; },
    g => { g.nodes[0].memberships = [{ parent_id: 'topic', role: 'primary' }]; },
    g => { delete g.hierarchy_format; },
    g => { g.hierarchy_format = 'unknown'; },
    g => { g.nodes[0].source_ref.utterance_ids = ['invented']; },
    g => { g.nodes[0].timestamp_start = 900; },
    g => { g.conversation_threads[0].steps[0].moment_id = 'invented'; },
  ])('refuses malformed, ambiguous, cyclic or unsupported claims without repairing their meaning', mutate => {
    const value = graph(); mutate(value);
    expect(() => convert(value)).toThrow('Invalid generated conversation graph.');
  });
});
