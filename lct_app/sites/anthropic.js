import { buildRecordingGenerationMessages, recordingThreadsFromGeneratedText } from '../src/services/cloud/openRouterGeneration.js';
import { ANTHROPIC_GENERATION_GRAPH_SCHEMA } from '../src/services/cloud/generationSchema.js';

export function anthropicHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
}

export function buildAnthropicGenerationRequest({ source, model, maxTokens }) {
  const [system, user] = buildRecordingGenerationMessages(source, maxTokens);
  return { model, max_tokens: maxTokens, stream: false, system: system.content, messages: [user],
    output_config: { format: { type: 'json_schema', schema: ANTHROPIC_GENERATION_GRAPH_SCHEMA } } };
}

function invalid(stage) {
  return Object.assign(new Error('Anthropic returned an incomplete or invalid map.'), { validationStage: stage });
}

export function recordingThreadsFromAnthropicResponse({ source, response }) {
  if (response?.type !== 'message' || response.role !== 'assistant' || response.error != null || !Array.isArray(response.content)) {
    throw invalid('response_envelope');
  }
  if (response.stop_reason !== 'end_turn') throw invalid('choice_finish');
  const text = response.content.filter(block => block?.type === 'text');
  const unexpected = response.content.some(block => !['text', 'thinking', 'redacted_thinking'].includes(block?.type));
  if (unexpected || text.length !== 1 || typeof text[0].text !== 'string' || !text[0].text.trim()) {
    throw invalid('choice_content');
  }
  return recordingThreadsFromGeneratedText(source, text[0].text);
}
