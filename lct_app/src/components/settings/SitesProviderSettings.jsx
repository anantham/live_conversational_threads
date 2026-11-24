import { useState } from 'react';
import PropTypes from 'prop-types';
import { useSitesRuntime } from '../../contexts/SitesRuntimeContext';
import { MAP_PROVIDERS } from '../../services/cloud/openRouterClient';
import { SPEECH_PROVIDERS, validPersonalKey } from '../../services/cloud/sitesProviderPreferences';

const speechGroup = {
  title: 'Speech-to-text',
  intro: 'Set the order for audio files. Live recording uses the first provider in the list that supports live audio.',
  providers: SPEECH_PROVIDERS,
};
const mapGroup = {
  title: 'Intelligence',
  intro: 'Set which provider turns transcripts into maps and threads. The next provider can run if an earlier one is unavailable or definitively refuses the request.',
  providers: MAP_PROVIDERS,
};
const input = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm';
const button = 'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium disabled:opacity-40';

function ProviderCredentials({ backend, speech }) {
  const { keys, preferences, save, setKey } = useSitesRuntime();
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [checking, setChecking] = useState(false);
  const key = keys[backend] || '';
  const model = preferences.models[backend] || '';
  const name = (speech ? SPEECH_PROVIDERS : MAP_PROVIDERS)[backend].name;

  async function check() {
    setChecking(true);
    setFeedback('');
    try {
      const response = await fetch('/api/cloud/providers/check', { method: 'POST', credentials: 'same-origin',
        redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-LCT-Key-Check': 'check-v1' },
        body: JSON.stringify({ backend, key, model, provider: preferences.openrouterProvider }) });
      const result = await response.json();
      setFeedback(response.ok ? result.message : result.error);
    } catch { setFeedback('The connection check could not finish.'); }
    finally { setChecking(false); }
  }

  return <details className="border-t border-slate-100 pt-2">
    <summary className="min-h-10 cursor-pointer py-2.5 text-sm font-medium text-slate-700">
      {key ? 'Personal key set for this tab' : backend === 'openai' ? 'Add a personal key' : 'Configure a personal key'}
    </summary>
    <div className="grid gap-3 pb-2 pt-2 sm:grid-cols-2">
      {!speech && <label className="grid gap-1 text-sm">Model ID
        <input className={input} key={backend} defaultValue={model} maxLength={160} placeholder={backend === 'anthropic' ? 'claude-sonnet-5-5' : 'Enter model ID'}
          onBlur={event => save({ models: { ...preferences.models, [backend]: event.target.value.trim() } })} />
      </label>}
      {backend === 'openrouter' && <label className="grid gap-1 text-sm">Upstream provider slug
        <input className={input} defaultValue={preferences.openrouterProvider} maxLength={80} placeholder="e.g. google"
          onBlur={event => save({ openrouterProvider: event.target.value.trim() })} />
      </label>}
      <label className="grid gap-1 text-sm sm:col-span-2">{name} API key
        <input className={input} type="password" autoComplete="new-password" value={draft} maxLength={512}
          placeholder={key ? 'Enter a replacement key' : 'Enter your API key'} onChange={event => setDraft(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="button" className={button} disabled={checking || !validPersonalKey(draft.trim())} onClick={() => { setKey(backend, draft.trim()); setDraft(''); setFeedback('Key saved for this tab.'); }}>Use for this session</button>
        <button type="button" className={button} disabled={!key || checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Test connection'}</button>
        {key && <button type="button" className={button} disabled={checking} onClick={() => { setKey(backend, ''); setFeedback('Personal key removed.'); }}>Remove key</button>}
      </div>
      {feedback && <p role="status" className="text-sm text-slate-600 sm:col-span-2">{feedback}</p>}
    </div>
  </details>;
}
ProviderCredentials.propTypes = { backend: PropTypes.string.isRequired, speech: PropTypes.bool.isRequired };

function ProviderOrder({ group, preference }) {
  const { preferences, save, keys } = useSitesRuntime();
  const order = preferences[preference];
  const ids = [...order, ...Object.keys(group.providers).filter(id => !order.includes(id))];

  function move(id, direction) {
    const index = order.indexOf(id);
    const next = [...order];
    [next[index], next[index + direction]] = [next[index + direction], id];
    save({ [preference]: next });
  }

  return <section id={preference === "speech" ? "speech-to-text" : "intelligence"} className="scroll-mt-5 space-y-3">
    <header>
      <h3 className="text-lg font-semibold text-slate-900">{group.title}</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{group.intro}</p>
    </header>
    <ol className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white px-4">
      {ids.map(id => {
        const index = order.indexOf(id);
        const { name, detail } = group.providers[id];
        return <li key={id} className="space-y-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={index >= 0} disabled={index === 0 && order.length === 1}
                onChange={event => save({ [preference]: event.target.checked ? [...order, id] : order.filter(provider => provider !== id) })} />
              <span><span className="block font-medium text-slate-900">{name}</span>
                <span className="text-sm text-slate-600">{detail ?? (keys[id] ? 'Personal account' : 'Site configuration')}</span></span>
            </label>
            {index >= 0 && <div className="flex items-center gap-1.5">
              <span className="mr-1 text-sm text-slate-600">{index === 0 ? 'First choice' : `Fallback ${index}`}</span>
              <button type="button" className={button} disabled={!index} onClick={() => move(id, -1)} aria-label={`Move ${name} up`}>Move up</button>
              <button type="button" className={button} disabled={index >= order.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${name} down`}>Move down</button>
            </div>}
          </div>
          <ProviderCredentials backend={id} speech={preference === 'speech'} />
        </li>;
      })}
    </ol>
  </section>;
}
ProviderOrder.propTypes = { group: PropTypes.object.isRequired, preference: PropTypes.string.isRequired };

export default function SitesProviderSettings() {
  const { storageError } = useSitesRuntime();
  return <div className="max-w-3xl space-y-7">
    <header>
      <h2 className="text-xl font-semibold text-slate-900">Providers</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Provider order and models are saved in this browser. Personal keys stay in this tab until reload or close.</p>
    </header>
    <nav aria-label="Provider categories" className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-slate-700">
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#speech-to-text">Speech-to-text</a>
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="#intelligence">Intelligence</a>
    </nav>
    {storageError && <p role="alert" className="text-sm text-rose-800">{storageError}</p>}
    <ProviderOrder group={speechGroup} preference="speech" />
    <ProviderOrder group={mapGroup} preference="map" />
  </div>;
}
