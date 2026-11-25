import { describe, expect, it } from 'vitest';
import { EPISTEMIC_FORMAT, epistemicFromGeneratedText } from './epistemicTask.js';
import { DETAIL_FORMAT, DETAIL_SCHEMA } from './generationTasks.js';
import { expandTaskGeneration } from './rangeGeneration.js';
import { expandGenerationHierarchy } from './generationHierarchy.js';

const utteranceIds = ['utterance-0001', 'utterance-0002', 'utterance-0003'];

describe('epistemicTask', () => {
  it('parses valid cruxes, factual claims, and normative assumptions while dropping bad ranges and unknown nodes', () => {
    const content = JSON.stringify({
      format: EPISTEMIC_FORMAT,
      cruxes: [
        {
          node_id: '3:co-living',
          label: 'Solo funding vs shared buy-in',
          note: 'Whether financial constraints are a blocker or a catalyst for shared ownership.',
          provenance: 'stated',
          range: { from: 'utterance-0001', to: 'utterance-0002' },
        },
        {
          node_id: '3:missing-node',
          label: 'Should be dropped',
          note: 'Unknown node.',
          provenance: 'stated',
          range: { from: 'utterance-0001', to: 'utterance-0001' },
        },
      ],
      factual_claims: [
        {
          node_id: '3:co-living',
          statement: 'Retreat begins on the 25th.',
          provenance: 'disputed',
          range: { from: 'utterance-0002', to: 'utterance-0003' },
        },
        {
          node_id: '3:co-living',
          statement: 'Bad range claim.',
          provenance: 'stated',
          range: { from: 'utterance-9999', to: 'utterance-9999' },
        },
      ],
      normative_assumptions: [
        {
          node_id: '3:co-living',
          statement: 'Shared responsibility builds deeper community than solo sponsorship.',
          note: 'Implicit value behind preferring co-ownership.',
          provenance: 'stated',
          range: { from: 'utterance-0001', to: 'utterance-0003' },
        },
      ],
    });

    const parsed = epistemicFromGeneratedText(utteranceIds, content, ['3:co-living']);
    expect(parsed.cruxes).toHaveLength(1);
    expect(parsed.cruxes[0]).toMatchObject({
      node_id: '3:co-living',
      label: 'Solo funding vs shared buy-in',
      provenance: 'stated',
      utterance_ids: ['utterance-0001', 'utterance-0002'],
    });
    expect(parsed.factual_claims).toHaveLength(1);
    expect(parsed.factual_claims[0]).toMatchObject({
      node_id: '3:co-living',
      statement: 'Retreat begins on the 25th.',
      provenance: 'disputed',
      utterance_ids: ['utterance-0002', 'utterance-0003'],
    });
    expect(parsed.normative_assumptions).toHaveLength(1);
    expect(parsed.unknownNodes).toBe(1);
    expect(parsed.droppedRanges).toBe(1);
    expect(parsed.malformed).toBe(0);
  });
});

describe('detail stopping rule (chunks directly under topics)', () => {
  it('allows DETAIL_SCHEMA and hierarchy expansion to attach a chunk directly to a level-3 topic without a wrapper idea', () => {
    const chunkSchema = DETAIL_SCHEMA.properties.nodes.items.anyOf[0];
    expect(chunkSchema.properties.parent_id.anyOf[0].properties.semantic_level.enum).toEqual([2, 3]);

    const detailReply = {
      hierarchy_format: DETAIL_FORMAT,
      nodes: [
        {
          id: 'cab-decision',
          semantic_level: 1,
          semantic_type: 'chunk',
          node_name: 'Book the cab for 6 PM',
          summary: 'Quick agreement on departure time.',
          source_range: { from: 'utterance-0001', to: 'utterance-0002' },
          parent_id: { semantic_level: 3, id: 'logistics' },
          secondary_parent_ids: [],
        },
      ],
      edges: [],
      boundary_notes: [],
    };

    const expanded = expandTaskGeneration(detailReply, utteranceIds, {
      topics: [{ id: 'logistics', node_name: 'Logistics', summary: 'Travel timing.' }],
    });
    const validated = expandGenerationHierarchy(expanded.graph);
    const chunk = validated.nodes.find(n => n.id === '1:cab-decision');
    expect(chunk.parent_id).toBe('3:logistics');
  });
});
