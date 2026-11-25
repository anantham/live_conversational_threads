import { describe, expect, it } from 'vitest';
import { EPISTEMIC_FORMAT, epistemicFromGeneratedText } from './epistemicTask.js';
import { DETAIL_PROMPT, detailNestedSchema, SKELETON_PROMPT } from './generationTasks.js';

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

describe('stopping rule in the prompts and nested detail schema', () => {
  // The nested-reply path itself (topic_chunks filed under a topic) is exercised in glanceDetailPipeline.test.js.
  it('states the stopping rule at both tiers and lets a detail chunk file directly under a segment topic', () => {
    expect(SKELETON_PROMPT).toContain('Stopping rule:');
    expect(DETAIL_PROMPT).toContain('Stopping rule:');
    expect(DETAIL_PROMPT).toContain('topic_chunks');
    const nested = detailNestedSchema(['logistics']);
    expect(nested.properties.ideas.items.properties.topic_id.anyOf[0].enum).toEqual(['logistics']);
    expect(nested.required).toContain('topic_chunks');
    expect(nested.properties.topic_chunks.items.properties.topic_id.enum).toEqual(['logistics']);
  });
});
