import { callServerlessLlm } from './llmClient';
import prompts from './prompts.json' with { type: 'json' };

export async function extractThreads(apiKey, transcriptSegment, existingNodes = []) {
  // ADR-060: We write a new OpenAI-specific extraction based on the local-model prompt shape,
  // which is already structurally robust, rather than porting the Gemini-specific logic.
  let template = prompts.prompts.generate_conversation_hierarchy_local?.template;
  
  if (!template) {
    // Fallback if not found
    template = `You structure transcript text into conversation graph nodes.
You author a TWO-LEVEL hierarchy for the CURRENT transcript segment.

Hierarchy contract:
1. chunk (semantic_level = 1)
2. idea (semantic_level = 2, groups 2-4 chunks)

Return JSON in this shape:
{
  "nodes": [
    {
      "id": "chunk-001",
      "node_name": "Short descriptive title",
      "summary": "Readable summary of this unit",
      "source_excerpt": "Direct supporting excerpt",
      "semantic_level": 1,
      "semantic_type": "chunk",
      "parent_id": "idea-001",
      "children_ids": [],
      "thread_id": "thread-vision",
      "speaker_id": "SPEAKER_00"
    }
  ]
}`;
  }

  const systemPrompt = template;
  
  const userPrompt = `
Existing JSON (do not rewrite prior nodes, only link to them if continuing):
${JSON.stringify(existingNodes.length ? { nodes: existingNodes } : { nodes: [] }, null, 2)}

Current Transcript Segment to structure:
${transcriptSegment}
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  const result = await callServerlessLlm(apiKey, messages, { 
    model: "gpt-4o", 
    temperature: 0.3,
    jsonMode: true 
  });
  
  return result.nodes || [];
}
