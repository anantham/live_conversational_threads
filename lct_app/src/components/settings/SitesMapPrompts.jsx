import { useState } from 'react';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { RECORDING_MAP_PROMPT } from '../../services/cloud/openRouterGeneration';
import { MAP_GUIDANCE_LIMIT } from '../../services/cloud/sitesProviderPreferences';
import useUnsavedChangesGuard from './useUnsavedChangesGuard';

const button = 'min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-40';

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

  return <section className="max-w-3xl space-y-4">
    <header>
      <h2 className="text-xl font-semibold text-slate-900">Conversation map prompt</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Add instructions for future maps. Your guidance is applied to each provider in your fallback order.</p>
    </header>
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
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium">Base prompt and evidence rules</summary>
      <p className="mt-3 leading-6 text-slate-700">{RECORDING_MAP_PROMPT}</p>
    </details>
  </section>;
}
