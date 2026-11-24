import { useState } from 'react';
import PropTypes from 'prop-types';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import ProviderKeyForm from './ProviderKeyForm';
import { MAP_PROVIDERS } from '../../services/cloud/openRouterClient';
import { MAP_PROVIDER_IDS, MAX_MAP_ROUTES, SPEECH_PROVIDERS, validModelId } from '../../services/cloud/sitesProviderPreferences';

const speechGroup = {
  title: 'Speech-to-text',
  intro: 'Set the order for audio files. Live recording uses the first provider in the list that supports live audio.',
  providers: SPEECH_PROVIDERS,
};
const input = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm';
const button = 'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium disabled:opacity-40';
const CUSTOM_MODEL = '__custom__';

function modelsForProvider(backend, catalogs) {
  return catalogs[backend] || [];
}

function SpeechOrder() {
  const { preferences, save, keys } = useSitesRuntime();
  const order = preferences.speech;
  const ids = [...order, ...Object.keys(speechGroup.providers).filter(id => !order.includes(id))];

  function move(id, direction) {
    const index = order.indexOf(id);
    const next = [...order];
    [next[index], next[index + direction]] = [next[index + direction], id];
    save({ speech: next });
  }

  return <section id="speech-to-text" className="scroll-mt-5 space-y-3">
    <header>
      <h3 className="text-lg font-semibold text-slate-900">{speechGroup.title}</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{speechGroup.intro}</p>
    </header>
    <ol className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white px-4">
      {ids.map(id => {
        const index = order.indexOf(id);
        const { name, detail } = speechGroup.providers[id];
        return <li key={id} className="space-y-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={index >= 0} disabled={index === 0 && order.length === 1}
                onChange={event => save({ speech: event.target.checked ? [...order, id] : order.filter(provider => provider !== id) })} />
              <span><span className="block font-medium text-slate-900">{name}</span>
                <span className="text-sm text-slate-600">{detail ?? (keys[id] ? 'Personal account' : 'Site configuration')}</span></span>
            </label>
            {index >= 0 && <div className="flex items-center gap-1.5">
              <span className="mr-1 text-sm text-slate-600">{index === 0 ? 'First choice' : `Fallback ${index}`}</span>
              <button type="button" className={button} disabled={!index} onClick={() => move(id, -1)} aria-label={`Move ${name} up`}>Move up</button>
              <button type="button" className={button} disabled={index >= order.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${name} down`}>Move down</button>
            </div>}
          </div>
          <ProviderKeyForm backend={id} name={name} speech />
        </li>;
      })}
    </ol>
  </section>;
}

function FallbackRow({ entry, index, total, onUpdate, onMove, onRemove }) {
  const { keys, catalogs } = useSitesRuntime();
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const options = modelsForProvider(entry.backend, catalogs);
  const hasKey = Boolean(keys[entry.backend]);
  const inList = !entry.model || options.some(item => item.id === entry.model);
  const rankLabel = index === 0 ? 'First choice' : `Fallback ${index}`;

  function handleProviderChange(nextBackend) {
    const nextModels = modelsForProvider(nextBackend, catalogs);
    const nextModel = keys[nextBackend] ? (nextModels[0]?.id || '') : '';
    setCustomMode(false);
    onUpdate(index, { backend: nextBackend, model: nextModel });
  }

  function handleModelSelect(value) {
    if (value === CUSTOM_MODEL) {
      setCustomDraft(entry.model || '');
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    onUpdate(index, { ...entry, model: value });
  }

  function commitCustom() {
    const trimmed = customDraft.trim();
    if (validModelId(trimmed)) onUpdate(index, { ...entry, model: trimmed });
    setCustomMode(false);
  }

  return <li className="space-y-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium text-slate-700">{rankLabel}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={button} disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move ${rankLabel} up`}>Move up</button>
        <button type="button" className={button} disabled={index >= total - 1} onClick={() => onMove(index, 1)} aria-label={`Move ${rankLabel} down`}>Move down</button>
        <button type="button" className={button} disabled={total <= 1} onClick={() => onRemove(index)} aria-label={`Remove ${rankLabel}`}>Remove</button>
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">Provider
        <select className={input} aria-label={`${rankLabel} provider`} value={entry.backend} onChange={event => handleProviderChange(event.target.value)}>
          {MAP_PROVIDER_IDS.map(id => <option key={id} value={id}>
            {MAP_PROVIDERS[id].name}{keys[id] ? ' (Personal key)' : ' (Site)'}
          </option>)}
        </select>
      </label>
      {customMode ? <div className="grid gap-1 text-sm">
        <label htmlFor={`custom-model-${index}`}>Custom model ID</label>
        <div className="flex gap-2">
          <input id={`custom-model-${index}`} className={input} value={customDraft} maxLength={160}
            placeholder="Enter model ID"
            onChange={event => setCustomDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitCustom(); } }} />
          <button type="button" className={button} disabled={!validModelId(customDraft)} onClick={commitCustom}>Set</button>
          <button type="button" className={button} onClick={() => setCustomMode(false)}>Cancel</button>
        </div>
      </div> : <label className="grid gap-1 text-sm">Model
        <select className={input} aria-label={`${rankLabel} model`} value={entry.model || ''} onChange={event => handleModelSelect(event.target.value)}>
          <option value="">Site default</option>
          {!inList && entry.model && <option value={entry.model}>{entry.model} (saved ID)</option>}
          {options.map(item => <option key={item.id} value={item.id}>{item.label === item.id ? item.id : `${item.label} (${item.id})`}</option>)}
          <option value={CUSTOM_MODEL}>Custom model ID…</option>
        </select>
      </label>}
      {entry.backend === 'openrouter' && hasKey && <label className="grid gap-1 text-sm sm:col-span-2">Upstream provider slug (optional)
        <input className={input} defaultValue={entry.provider || ''} key={`${index}-${entry.backend}-${entry.provider || ''}`} maxLength={80}
          placeholder="Auto (let OpenRouter route)"
          onBlur={event => onUpdate(index, { ...entry, provider: event.target.value.trim() })} />
      </label>}
    </div>
    {entry.model && !hasKey && <p className="text-xs text-amber-800">Add a personal {MAP_PROVIDERS[entry.backend].name} key above to use a specific model; without one, this step uses Site configuration.</p>}
    {!entry.model && hasKey && <p className="text-xs text-amber-800">{options.length ? 'Select a model to use your personal key.' : 'Enter a custom model ID if your model is unavailable.'}</p>}
  </li>;
}
FallbackRow.propTypes = {
  entry: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onUpdate: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

function IntelligenceSettings() {
  const { preferences, save, keys, catalogs } = useSitesRuntime();
  const chain = preferences.mapChain || [{ backend: 'openrouter', model: '' }];

  function updateEntry(index, nextEntry) {
    const next = chain.map((item, i) => (i === index ? nextEntry : item));
    save({ mapChain: next });
  }

  function moveEntry(index, direction) {
    const next = [...chain];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    save({ mapChain: next });
  }

  function removeEntry(index) {
    if (chain.length <= 1) return;
    save({ mapChain: chain.filter((_, i) => i !== index) });
  }

  function addEntry() {
    if (chain.length >= MAX_MAP_ROUTES) return;
    const used = new Set(chain.map(item => `${item.backend}|${item.model}`));
    const preferredOrder = [
      ...MAP_PROVIDER_IDS.filter(id => keys[id]),
      ...MAP_PROVIDER_IDS.filter(id => !keys[id]),
    ];
    for (const backend of preferredOrder) {
      if (keys[backend]) {
        const candidate = modelsForProvider(backend, catalogs).find(item => !used.has(`${backend}|${item.id}`));
        if (candidate) { save({ mapChain: [...chain, { backend, model: candidate.id }] }); return; }
      } else if (!used.has(`${backend}|`)) {
        save({ mapChain: [...chain, { backend, model: '' }] });
        return;
      }
    }
    const fallbackBackend = preferredOrder[0];
    const fallbackModel = modelsForProvider(fallbackBackend, catalogs).find(item => !used.has(`${fallbackBackend}|${item.id}`))?.id || '';
    save({ mapChain: [...chain, { backend: fallbackBackend, model: fallbackModel }] });
  }

  return <section id="intelligence" className="scroll-mt-5 space-y-6">
    <header>
      <h3 className="text-lg font-semibold text-slate-900">Intelligence</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
        Connect personal keys per provider, then order the models that turn transcripts into maps. You can add multiple models from the same provider.
      </p>
    </header>

    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800">Provider accounts & keys</h4>
      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white px-4">
        {MAP_PROVIDER_IDS.map(id => {
          const { name } = MAP_PROVIDERS[id];
          return <li key={id} className="space-y-1 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">{name}</span>
              <span className="text-sm text-slate-600">{keys[id] ? 'Personal key active' : 'Site configuration'}</span>
            </div>
            <ProviderKeyForm backend={id} name={name} />
          </li>;
        })}
      </ul>
    </div>

    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">Model fallback order</h4>
        <button type="button" className={button} disabled={chain.length >= MAX_MAP_ROUTES} onClick={addEntry}>+ Add model</button>
      </div>
      <ol className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white px-4">
        {chain.map((entry, index) => <FallbackRow
          key={`${index}-${entry.backend}-${entry.model}`}
          entry={entry}
          index={index}
          total={chain.length}
          onUpdate={updateEntry}
          onMove={moveEntry}
          onRemove={removeEntry}
        />)}
      </ol>
    </div>
  </section>;
}

export default function SitesProviderSettings() {
  const { storageError, credentialError, credentialsReady } = useSitesRuntime();
  return <div className="max-w-3xl space-y-7">
    <header>
      <h2 className="text-xl font-semibold text-slate-900">Providers</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Keys, model lists, and fallback order are saved in this browser.</p>
    </header>
    <nav aria-label="Provider categories" className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-slate-700">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#speech-to-text">Speech-to-text</a>
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#intelligence">Intelligence</a>
    </nav>
    {!credentialsReady && <p role="status" className="text-sm text-slate-600">Loading saved provider keys…</p>}
    {credentialError && <p role="alert" className="text-sm text-rose-800">{credentialError}</p>}
    {storageError && <p role="alert" className="text-sm text-rose-800">{storageError}</p>}
    <SpeechOrder />
    <IntelligenceSettings />
  </div>;
}
