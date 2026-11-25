import { useState } from 'react';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { RECORDING_MAP_PROMPT } from '../../services/cloud/openRouterGeneration';
import { GENERATION_GRAPH_SCHEMA } from '../../services/cloud/generationSchema';
import { DETAIL_PROMPT, DETAIL_SCHEMA, SKELETON_PROMPT, SKELETON_SCHEMA } from '../../services/cloud/generationTasks';
import { AUDIT_PROMPT, AUDIT_SCHEMA } from '../../services/cloud/auditTask';
import { MAP_GUIDANCE_LIMIT } from '../../services/cloud/sitesProviderPreferences';
import useUnsavedChangesGuard from './useUnsavedChangesGuard';

const button = 'min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-40';

const API_REQUEST_DEFAULTS = [
  {
    name: 'Map generation (Anthropic · OpenRouter · Gemini)',
    endpoint: 'POST /api/cloud/map/generate',
    details: 'stream: false · strict JSON schema (lct_recording_graph_v2 / skeleton-ranges-v1 / detail-ranges-v1 / audit-v1) · max_tokens: 8,192 (short ≤5 min) or up to 16,384 (long >5 min) · OpenRouter: data_collection=deny, require_parameters=true, allow_fallbacks=false · Anthropic: anthropic-version=2023-06-01',
  },
  {
    name: 'Live & file speech-to-text (Soniox)',
    endpoint: 'POST /api/cloud/soniox/session · WebSocket /v1/transcribe-websocket',
    details: 'Live model: stt-rt-v4 · Audio file model: stt-async-v4 · speaker diarization enabled · no LLM prompt used',
  },
  {
    name: 'Audio file speech-to-text fallback (OpenAI)',
    endpoint: 'POST https://api.openai.com/v1/audio/transcriptions',
    details: 'Model: gpt-4o-transcribe-diarize · response_format: diarized_json · chunking_strategy: auto · no LLM prompt used',
  },
  {
    name: 'Provider key check & live model list',
    endpoint: 'POST /api/cloud/providers/check',
    details: 'Metadata-only GET (/v1/models or /api/v1/key) · zero transcript content · zero prompt',
  },
];

export default function SitesMapPrompts() {
  const { preferences, save, storageError } = useSitesRuntime();
  const [guidance, setGuidance] = useState(preferences.guidance);
  const [message, setMessage] = useState('');
  useUnsavedChangesGuard(guidance !== preferences.guidance, 'Discard unsaved map prompt guidance?');

  function saveGuidance(value) {
    save({ guidance: value });
    setGuidance(value);
    setMessage(value ? 'Map guidance updated.' : 'Default map prompt restored.');
  }

  return <section className="max-w-3xl space-y-6">
    <header>
      <h2 className="text-xl font-semibold text-slate-900">Conversation map prompt</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Add instructions for future maps. Your guidance is applied to each provider in your fallback order.</p>
    </header>

    <div className="space-y-3">
      <label className="grid gap-2 text-sm font-medium text-slate-800">Additional guidance
        <textarea className="min-h-36 rounded-lg border border-slate-300 bg-white p-3 font-normal" value={guidance} maxLength={MAP_GUIDANCE_LIMIT}
          placeholder="For example, trace where participants change their minds and cite the turns that led there."
          onChange={event => { setGuidance(event.target.value); setMessage(''); }} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button + ' bg-slate-900 text-white'} disabled={guidance === preferences.guidance} onClick={() => saveGuidance(guidance)}>Save guidance</button>
        <button type="button" className={button} disabled={!guidance && !preferences.guidance} onClick={() => saveGuidance('')}>Restore default</button>
      </div>
      {message && <p role="status" className="text-sm text-slate-600">{message}</p>}
      {storageError && <p role="alert" className="text-sm text-rose-800">{storageError}</p>}
    </div>

    <div className="space-y-3 border-t border-slate-200 pt-5">
      <header>
        <h3 className="text-base font-semibold text-slate-900">Default prompts &amp; parameters used across all API requests</h3>
        <p className="mt-1 text-xs leading-5 text-slate-600">Read-only view of every system prompt, task prompt, schema, and wire default sent to AI and speech providers.</p>
      </header>

      <details open className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">1. Base map prompt and evidence rules (single-pass &amp; windowed maps)</summary>
        <p className="mt-3 whitespace-pre-line leading-6 text-slate-700">{RECORDING_MAP_PROMPT}</p>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">2. Glance overview prompt — Topics, Themes, Arcs &amp; Glossary (skeleton-ranges-v1)</summary>
        <p className="mt-3 whitespace-pre-line leading-6 text-slate-700">{SKELETON_PROMPT}</p>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">3. Topic detail prompt — Grounded Chunks, Ideas &amp; Boundary Notes (detail-ranges-v1)</summary>
        <p className="mt-3 whitespace-pre-line leading-6 text-slate-700">{DETAIL_PROMPT}</p>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">4. Second-family semantic audit prompt (audit-v1)</summary>
        <p className="mt-3 whitespace-pre-line leading-6 text-slate-700">{AUDIT_PROMPT}</p>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">5. Request defaults across all API endpoints</summary>
        <dl className="mt-3 divide-y divide-slate-100">
          {API_REQUEST_DEFAULTS.map(item => (
            <div key={item.name} className="py-2.5">
              <dt className="font-medium text-slate-900">{item.name}</dt>
              <dd className="mt-0.5 text-xs font-mono text-slate-500">{item.endpoint}</dd>
              <dd className="mt-1 text-xs leading-5 text-slate-700">{item.details}</dd>
            </div>
          ))}
        </dl>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-900">6. Structured output JSON schemas (map · skeleton · detail · audit)</summary>
        <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-700">
          {JSON.stringify({ map: GENERATION_GRAPH_SCHEMA, skeleton: SKELETON_SCHEMA, detail: DETAIL_SCHEMA, audit: AUDIT_SCHEMA }, null, 2)}
        </pre>
      </details>
    </div>
  </section>;
}
