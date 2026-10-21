// @vitest-environment node
// Test intent: tests/intent/tier-safe-generation.md. Synthetic only; no provider.
import { describe, expect, it } from 'vitest';
import { buildOpenRouterGenerationRequest, recordingThreadsFromOpenRouterResponse } from './openRouterGeneration.js';
import { readThreadsFile } from '../threadsArtifact.js';
import { buildDiscussionModel } from '../../components/discussion/discussionModel.js';

const source = { recordingId: 'synthetic-tiered', startedAt: Date.UTC(2026, 9, 21), complete: true,
  finalTokens: [{ text: 'A garden needs water.', speaker: 'S1', startMs: 0, endMs: 1200 }] };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, parent_id = null, secondary_parent_ids = []) => ({ id,
  semantic_level: level, semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1],
  node_name: `${id} level ${level}`, summary: 'Synthetic garden summary', source_excerpt: '',
  source_ref: { utterance_ids: ['utterance-0001'] }, parent_id, secondary_parent_ids, thread_id: 'garden' });
const graph = () => ({ hierarchy_format: 'tiered-parent-links-v2',
  nodes: [node(1, 'same', ref(2, 'same')), node(2, 'same', ref(3, 'topic'), [ref(3, 'overlap')]),
    node(3, 'topic', ref(5, 'arc')), node(3, 'overlap', ref(4, 'theme')),
    node(4, 'theme', ref(5, 'arc')), node(5, 'arc')],
  edges: [{ id: 'support', from_node_id: ref(1, 'same'), to_node_id: ref(3, 'topic'),
    relation_type: 'supports', edge_kind: 'semantic', explanation: 'Water supports the garden.', relation_text: '' }],
  metadata: { conversation_title: 'Synthetic garden', executive_summary: 'Water and care.' },
  conversation_threads: [{ id: 'garden', title: 'Garden care',
    steps: [{ moment_id: ref(1, 'same'), evidence_utterance_ids: ['utterance-0001'] }] }] });
const convert = value => recordingThreadsFromOpenRouterResponse({ source, response: {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
} });

describe('tier-safe generated maps through the public adapter', () => {
  it('preserves all five tiers, overlapping/skipped parents, edges, paths and exact source through the actual reader', async () => {
    const authored = graph(), before = JSON.stringify(authored);
    const opened = await readThreadsFile(convert(authored).file);
    expect(JSON.stringify(authored)).toBe(before);
    const byId = new Map(opened.graph_data.map(n => [n.id, n]));
    expect(opened.graph_data.map(n => n.semantic_level)).toEqual([1, 2, 3, 3, 4, 5]);
    expect(byId.get('1:same').parent_id).toBe('2:same');
    expect(byId.get('2:same').memberships).toEqual([
      { parent_id: '3:topic', role: 'primary' }, { parent_id: '3:overlap', role: 'secondary' },
    ]);
    expect(byId.get('3:topic').parent_id).toBe('5:arc');
    expect(byId.get('3:overlap').children_ids).toEqual(['2:same']);
    expect(opened.edges[0]).toMatchObject({ from_node_id: '1:same', to_node_id: '3:topic' });
    expect(opened.conversation_threads[0].steps[0].moment_id).toBe('1:same');
    expect(opened.full_transcript).toBe(source.finalTokens[0].text);
    expect(buildDiscussionModel(opened.graph_data, opened.utterances).utterancesByMoment.get('1:same'))
      .toEqual(['utterance-0001']);
  });

  it('keeps a short chunk-only graph valid without inventing higher tiers or paths', () => {
    const value = graph(); value.nodes = [node(1, 'single')]; value.edges = []; value.conversation_threads = [];
    expect(convert(value).bundle.graph_data).toMatchObject([{ id: '1:single', semantic_level: 1, children_ids: [] }]);
  });

  it.each([
    g => { g.nodes[1].parent_id = ref(1, 'same'); },
    g => { g.nodes[1].parent_id = ref(2, 'same'); },
    g => { g.nodes[1].secondary_parent_ids = [ref(1, 'same')]; },
    g => { g.nodes[1].parent_id = ref(3, 'missing'); },
    g => { g.nodes[1].parent_id = ref(3, 'same'); },
    g => { g.nodes[1].parent_id = 'topic'; },
    g => { g.nodes[1].secondary_parent_ids.push(ref(3, 'overlap')); },
    g => { g.nodes[1].secondary_parent_ids = [ref(3, 'topic')]; },
    g => { g.nodes.push({ ...g.nodes[0] }); },
    g => { g.nodes[1].semantic_type = 'chunk'; },
    g => { g.nodes[1].semantic_level = 2.5; },
    g => { g.nodes[0].id = 'x'.repeat(161); },
    g => { g.nodes[0].parent_id.extra = 'ambiguous'; },
    g => { g.edges[0].from_node_id = ref(6, 'same'); },
    g => { g.edges[0].to_node_id = ref(4, 'topic'); },
    g => { g.conversation_threads[0].steps[0].moment_id = ref(3, 'same'); },
    g => { g.nodes[0].source_ref.utterance_ids = ['invented']; },
    g => { g.nodes[0].children_ids = []; },
  ])('refuses malformed or contradictory authored choices without repairing meaning', mutate => {
    const value = graph(); mutate(value); const before = JSON.stringify(value);
    expect(() => convert(value)).toThrow('Invalid generated conversation graph.');
    expect(JSON.stringify(value)).toBe(before);
  });

  it('constrains the emitted schema to matching tiers and strictly higher typed parent coordinates', () => {
    const wire = buildOpenRouterGenerationRequest({ source, model: 'synthetic/model', maxTokens: 8192 });
    const shape = wire.response_format.json_schema.schema;
    expect(shape.properties.hierarchy_format.enum).toEqual(['tiered-parent-links-v2']);
    const variants = shape.properties.nodes.items.anyOf;
    expect(variants).toHaveLength(5);
    variants.forEach((variant, index) => {
      expect(variant.properties.semantic_level.enum).toEqual([index + 1]);
      expect(variant.properties.semantic_type.enum).toEqual([['chunk', 'idea', 'topic', 'theme', 'arc'][index]]);
      const parent = variant.properties.parent_id;
      if (index === 4) {
        expect(parent.type).toBe('null');
        expect(variant.properties.secondary_parent_ids.maxItems).toBe(0);
      } else {
        const coordinates = parent.anyOf.find(x => x.type === 'object');
        expect(coordinates.properties.semantic_level.enum).toEqual([2, 3, 4, 5].filter(x => x > index + 1));
        expect(coordinates.required).toEqual(['semantic_level', 'id']);
        expect(coordinates.additionalProperties).toBe(false);
      }
    });
  });
});
