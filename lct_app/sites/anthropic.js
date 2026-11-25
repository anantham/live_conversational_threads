import { buildRecordingGenerationMessages, generationTask, readGeneratedText } from '../src/services/cloud/openRouterGeneration.js';
import { AUDIT_SCHEMA } from '../src/services/cloud/auditTask.js';
import { EPISTEMIC_SCHEMA } from '../src/services/cloud/epistemicTask.js';
import { FACT_CHECK_SCHEMA } from '../src/services/cloud/factCheckTask.js';
import { ANTHROPIC_GENERATION_GRAPH_SCHEMA } from '../src/services/cloud/generationSchema.js';
import { ANTHROPIC_SKELETON_SCHEMA } from '../src/services/cloud/generationTasks.js';

// The detail schema is built per segment (its topic ids are an enum), so it comes from generationTask.
const ANTHROPIC_SCHEMAS = { map: ANTHROPIC_GENERATION_GRAPH_SCHEMA, skeleton: ANTHROPIC_SKELETON_SCHEMA, audit: AUDIT_SCHEMA, epistemic: EPISTEMIC_SCHEMA, fact_check: FACT_CHECK_SCHEMA };

export function anthropicHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
}

export function buildAnthropicGenerationRequest({ source, model, maxTokens, guidance, context }) {
  const [system, user] = buildRecordingGenerationMessages(source, maxTokens, guidance, context);
  return { model, max_tokens: maxTokens, stream: false, system: system.content, messages: [user],
    output_config: { format: { type: 'json_schema', schema: context?.task === 'detail' ? generationTask(context).schema : ANTHROPIC_SCHEMAS[context?.task ?? 'map'] } } };
}

function invalid(stage) {
  return Object.assign(new Error('Anthropic returned an incomplete or invalid map.'), { validationStage: stage });
}

export function recordingThreadsFromAnthropicResponse({ source, response, context }) {
  if (response?.type !== 'message' || response.role !== 'assistant' || response.error != null || !Array.isArray(response.content)) {
    throw invalid('response_envelope');
  }
  if (response.stop_reason !== 'end_turn') throw invalid('choice_finish');
  const text = response.content.filter(block => block?.type === 'text');
  const unexpected = response.content.some(block => !['text', 'thinking', 'redacted_thinking'].includes(block?.type));
  if (unexpected || text.length !== 1 || typeof text[0].text !== 'string' || !text[0].text.trim()) {
    throw invalid('choice_content');
  }
  return readGeneratedText(source, text[0].text, context);
}
